const {events, Job, Group} = require("brigadier")
const gh = require("./http")

// Or `make` or whatever you like
const taskRunner = 'variant'
const dest = "/workspace"
const image = "mumoshu/helmfile-chatops:0.2.0"
const commands = {
    apply: 'Apply changes',
    diff: 'Detect changes',
    test: 'Run integration tests',
    lint: 'Run lint checks',
}
const checkCommands = ["diff", "lint"]
const checkPrefix = "brigade"

async function handleIssueComment(e, p) {
    console.log("handling issue comment....")
    payload = JSON.parse(e.payload);

    // Extract the comment body and trim whitespace
    comment = payload.body.comment.body.trim();

    console.log("project", p)
    console.log("payload", payload)
    console.log("owner", payload.body.repository.owner)

    tmp = payload.body.repository.owner.html_url.split('/')
    let owner = tmp[tmp.length - 1]
    let repo = payload.body.repository.name;
    let issue = payload.body.issue.number;
    let ghtoken = p.secrets.githubToken;

    // Here we determine if a comment should provoke an action
    if (comment.startsWith("/")) {
        let cmd = comment.slice(1).split(' ')[0]
        let cmds = Object.keys(commands)
        if (cmds.includes(cmd)) {
            await gh.addComment(owner, repo, issue, `Processing ${comment}`, ghtoken)
            await runGithubCheckWithHelmfile(cmd, e, p)
            await gh.addComment(owner, repo, issue, `Finished processing ${comment}`, ghtoken)
            return
        } else {
            await gh.addComment('mumoshu', repo, issue, `Unsupported command ${comment}`, ghtoken)
        }
    }
    console.log(`No applicable action found for comment: ${comment}`);
}

function handlePush(e, p) {
    console.log("handling push....")
    console.log("payload", e.payload)
    var gh = JSON.parse(e.payload)
    if (e.type != "pull_request") {
        newJobForCommand("apply").run()
    }
}

const checkRunImage = "brigadecore/brigade-github-check-run:latest"

function getSuite(payload) {
    let suite = undefined
    let body = payload.body
    if (body.check_run) {
        suite = body.check_run.check_suite
    } else {
        suite = body.check_suite
    }
    return suite
}

function getPR(payload) {
    let pr
    let suite = getSuite(payload)
    if (suite) {
        pr = suite.pull_requests[0]
    } else {
        pr = payload.body.issue.pull_request
    }
    return pr
}

async function checkCompleted(e, p) {
    console.log('event', e)
    console.log('project', p)
    let payload = JSON.parse(e.payload);
    console.log('payload', payload)
    console.log('payload.body', payload.body)
    let suite = undefined
    let msg = undefined
    if (payload.body.check_run) {
        let run = payload.body.check_run;
        suite = run.check_suite
        let conc = run.conclusion
        let color
        // See https://stackoverflow.com/questions/11509830/how-to-add-color-to-githubs-readme-md-file how coloring works
        if (conc == 'failure') {
            color = '![#f03c15](https://placehold.it/15/f03c15/000000?text=+)'
        } else {
            color = '![#c5f015](https://placehold.it/15/c5f015/000000?text=+)'
        }
        msg = `${color} [${run.name}](${run.html_url}) on ${run.head_sha} finished with \`${conc}\``
    } else {
        suite = payload.body.check_suite
        msg = `Check suite [${suite.id}](${suite.url}) finished with \`${suite.conclusion}\``
    }
    console.log('check_suite', suite)

    // Leave comments for check runs only, because check suite events had no useful info like details page urls contained
    if (payload.body.check_run) {
        let prUrl = suite.pull_requests[0].url
        let resBody = await gh.get(prUrl, p.secrets.githubToken)
        let pr = JSON.parse(resBody)
        console.log('pr', pr)

        await gh.post(pr.comments_url, {body: msg}, p.secrets.githubToken)
    }
}

function checkSuiteRequested(id) {
    return async (e, p) => {
        payload = JSON.parse(e.payload)
        console.log(`${id}.payload`, payload)
        return await Promise.all(checkCommands.map((c) => runGithubCheckWithHelmfile(c, e, p)))
    }
}

function checkRunReRequested(id) {
    return async (e, p) => {
        payload = JSON.parse(e.payload)
        console.log(`${id}.payload`, payload)

        let run = payload.body.check_run
        let name = run.name;
        let cmd = name.split(`${checkPrefix}-`)[1]

        console.log(`check run named "${name}" got re-requested, hence running command "${cmd}"`)
        return await runGithubCheckWithHelmfile(cmd, e, p)
    }
}

// runGithubCheckWithHelmfile runs `helmfile ${cmd}` within a GitHub Check, so that its status(success, failure) and logs
// are visible in the pull request UI.
async function runGithubCheckWithHelmfile(cmd, e, p) {
    let payload = JSON.parse(e.payload)
    let prSummary = getPR(payload)
    let resBody = await gh.get(prSummary.url, p.secrets.githubToken)
    let pr = JSON.parse(resBody)
    let msg = `${cmd} started`
    let prComment = gh.post(pr.comments_url, {body: msg}, p.secrets.githubToken)

    const imageForcePull = false

    console.log("check requested")
    let desc = commands[cmd]
    // Common configuration
    const env = {
        CHECK_PAYLOAD: e.payload,
        CHECK_NAME: `${checkPrefix}-${cmd}`,
        // Shown in PR statuses and headers in check run details
        CHECK_TITLE: desc,
    }

    // This will represent our build job. For us, it's just an empty thinger.
    const build = newJobForCommand(cmd)
    build.streamLogs = true

    // For convenience, we'll create three jobs: one for each GitHub Check
    // stage.
    const start = new Job(`${cmd}-check-run-start`, checkRunImage)
    start.imageForcePull = imageForcePull
    start.env = env
    start.env.CHECK_SUMMARY = `${cmd} started`

    const end = new Job(`${cmd}-check-run-end`, checkRunImage)
    end.imageForcePull = imageForcePull
    end.env = env

    try {
        // Now we run the jobs in order:
        // - Notify GitHub of start
        // - Run the test
        // - Notify GitHub of completion
        //
        // On error, we catch the error and notify GitHub of a failure.
        let results = await Promise.all([
            prComment,
            start.run(),
            // In case you see errors like the below in a helmfile pod:
            //   Error: secrets is forbidden: User "system:serviceaccount:default:brigade-worker" cannot list resource "secrets" in API group "" in the namespace "kube-system"
            // It is likely you don't have correct premissions provided to the job pod that runs helmfile.
            // Run something like the below, for testing purpose:
            //   kubectl create clusterrolebinding brigade-worker-as-cluster-admin --serviceaccount default:brigade-worker --clusterrole cluster-admin
            // Hopefully you'll use something stricter in a prod env :)
            build.run()
        ])

        let startResult = results[1]

        // let check = JSON.parse(startResult.toString())
        console.log('check.start.result', startResult.toString())

        let result = results[2]

        end.env.CHECK_CONCLUSION = "success"
        end.env.CHECK_SUMMARY = `${cmd}} completed`
        end.env.CHECK_TEXT = result.toString()
    } catch (err) {
        let logs = "N/A"
        try {
            logs = await build.logs()
        } catch (err2) {
            console.log("failed while gathering logs", {cmd: cmd}, err2)
        }

        // In this case, we mark the ending failed.
        end.env.CHECK_CONCLUSION = "failure"
        end.env.CHECK_SUMMARY = `${cmd} failed`
        end.env.CHECK_TEXT = `Error: ${err}

Logs:
${logs}`
    }
    return await end.run()
}

function newJobForCommand(cmd) {
    var job = new Job(cmd, image)
    job.tasks = [
        "mkdir -p " + dest,
        "cp -a /src/* " + dest,
        "cd " + dest,
        `${taskRunner} ${cmd}`,
    ]
    return job
}

events.on("push", handlePush)
events.on("issue_comment:created", handleIssueComment);
// `check_suite:requested` seems to be triggered out of the band of brigade-github-app on every push to a pull request.
// On the other hand brigade-github-app triggers check_suite:rerequested on every push to a pull request
// This results in two consecutive and duplicate check suite runs on every push to a pull request
// We disable the GitHub native one here so that we don't end duplicate runs.
//events.on("check_suite:requested", checkSuiteRequested('check_suite:requested'))
events.on("check_suite:rerequested", checkSuiteRequested('check_suite:rerequested'))
events.on("check_run:rerequested", checkRunReRequested('check_run:rerequested'))
events.on("check_run:completed", checkCompleted)
events.on("check_suite:completed", checkCompleted)
