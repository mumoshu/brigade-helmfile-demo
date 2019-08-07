const {events, Job, Group} = require("brigadier")
const gh = require("./http")

// Or `make` or whatever you like
const taskRunner = 'variant'

// workspace is the directory in jobs where the git repository is cloned to and tasks are run in
const workspace = "/workspace"

// image is the container image used for jobs, which should contain the task runner
const image = "mumoshu/helmfile-chatops:0.2.0"

// commands is the list of supported slash commands and its descriptions
const commands = {
    apply: 'Apply changes',
    diff: 'Detect changes',
    test: 'Run integration tests',
    lint: 'Run lint checks',
    deploy: 'Deploy changes',
}

// checkCommands is the list of commands that are triggered when a new commit is pushed to a pull request
const checkCommands = ["diff", "lint"]

// pushCommands is the list of commands that are triggered when a new commit is pushed to non-pr branches
const pushCommands = ["apply"]

const checkPrefix = "brigade"
const checkRunImage = "brigadecore/brigade-github-check-run:latest"

// maxLogLines is the number of lines of logs for each check run that is shown in the GitHub Check UI
const maxLogLines = 102400

// kinds is the list of custom resource kinds, in their lower-cased names, that are handled and reconciled
const kinds = ["releaseset"]

// command creates a Brigade job for running `cmd`.
function command(cmd, opts) {
    let job = new Job(cmd, image)
    job.tasks = [
        "mkdir -p " + workspace,
        "cp -a /src/* " + workspace,
        "cd " + workspace,
        `${taskRunner} ${cmd}`,
    ]
    if (typeof opts == "object") {
        for (let k of Object.keys(opts)) {
            job[k] = opts[k]
        }
    }
    return job
}

// checkRunCompletionMessage returns the message sent back to the pull request when a check run completed
function checkRunCompletionMessage(run) {
    let conc = run.conclusion
    let color
    // See https://stackoverflow.com/questions/11509830/how-to-add-color-to-githubs-readme-md-file how coloring works
    if (conc == 'failure') {
        color = '![#f03c15](https://placehold.it/15/f03c15/000000?text=+)'
    } else {
        color = '![#c5f015](https://placehold.it/15/c5f015/000000?text=+)'
    }
    return `${color} [${run.name}](${run.html_url}) on ${run.head_sha} finished with \`${conc}\``
}

function handleReleaseSet(kind, action) {
    return async (e, p) => {
        console.log(`handling ${kind}...`)
        payload = JSON.parse(e.payload);

        console.log("project", p)
        console.log("payload", payload)

        let body = payload.body
        annotations = body.metadata.annotations
        console.log("annotations", annotations)

        // Send feedback comments to the pull request with the pullID
        let ghtoken = p.secrets.githubToken;
        let resBody = await gh.get(payload.pullURL, ghtoken)
        let pr = JSON.parse(resBody)

        let token = payload.token

        function newCheckRunStart() {
            return {
                'name': `brigade-cd-${payload.type}-${action}`,
                // head_branch: payload.branch,
                'head_sha': payload.commit,
                // or "success", "failure"
                // conclusion: "",
                // details_url: "",
                // external_id: "",
                // or "completed"
                'status': "in_progress",
                'started_at': new Date().toISOString(),
                // completed_at: null,
                // output: null,
                // actions: []
            }
        }

        function newCheckRunEnd(conclusion, title, summary, text) {
            let run = newCheckRunStart()
            run['completed_at'] = new Date().toISOString()
            run['output'] = {
                'title': title,
                'summary': summary,
                'text': text
            }
            run['conclusion'] = conclusion
            return run
        }

        async function gatherLogs(build) {
            let logs = "N/A"
            try {
                logs = await build.logs()
            } catch (err2) {
                console.log("failed while gathering logs", err2)
            }
            if (logs.length > maxLogLines) {
                logs = logs.slice(maxLogLines)
            }
            return logs
        }

        let run = newCheckRunStart()

        function lastLines(text, n) {
            return text.split("\n").slice(-1 - n, -1).join("\n") + "\n"
        }

        await gh.addComment(payload.owner, payload.repo, payload.pull, `Processing ${action}`, ghtoken)
        await gh.createCheckRun(payload.owner, payload.repo, run, token)
        let build = null
        let opts = {streamLogs: true}
        switch (action) {
            case "plan":
                // We have no way to run use the brigade's built-in check-run container to create/update check runs for payloads sent from brigade-cd
                // await checkWithHelmfile("diff", pr, e.payload, p)
                build = command("diff", opts)
                break
            case "apply":
                build = command("apply", opts)
                break
            case "destroy":
                build = command("destroy", opts)
                break
            default:
                await gh.addComment(payload.owner, repo, payload.pull, `Unsupported command ${action}`, ghtoken)
                break
        }
        try {
            let result = await build.run()
            // let logs = await gatherLogs(build)
            let text = `Logs:
${result.toString()}`
            let r = newCheckRunEnd("success", "Result", `${action} succeeded`, text)
            await gh.createCheckRun(payload.owner, payload.repo, r, token)
        } catch (err) {
            let logs = await gatherLogs(build)
            let text = `${err}

Logs:
${logs}`
            let r = newCheckRunEnd("failure", "Result", `${action} failed\\n\\n${lastLines(text, 10)}`, text)
            await gh.createCheckRun(payload.owner, payload.repo, r, token)
        }
        await gh.addComment(payload.owner, payload.repo, payload.pull, `Finished processing ${action}`, ghtoken)
    }
}

async function handleIssueComment(e, p) {
    console.log("handling issue comment....")
    payload = JSON.parse(e.payload);

    // Extract the comment body and trim whitespace
    comment = payload.body.comment.body.trim();
    commentId = payload.body.comment.id

    console.log("project", p)
    console.log("payload", payload)
    console.log("owner", payload.body.repository.owner)

    tmp = payload.body.repository.owner.html_url.split('/')
    let owner = tmp[tmp.length - 1]
    let repo = payload.body.repository.name;
    let issue = payload.body.issue.number;
    let ghtoken = p.secrets.githubToken;

    let reaction = gh.createIssueCommentReaction(owner, repo, commentId, "+1", ghtoken)

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

async function handlePush(e, p) {
    console.log("handling push....")
    console.log("payload", e.payload)
    var gh = JSON.parse(e.payload)
    if (e.type != "pull_request") {
        return await Promise.all(pushCommands.map((c) => command(c).run()))
    }
}

function getSuiteFromPayload(payload) {
    let suite = undefined
    let body = payload.body
    if (body.check_run) {
        suite = body.check_run.check_suite
    } else {
        suite = body.check_suite
    }
    return suite
}

function getPRFromPayload(payload) {
    let pr
    let suite = getSuiteFromPayload(payload)
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
        msg = checkRunCompletionMessage(run)
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
    let prSummary = getPRFromPayload(payload)
    let resBody = await gh.get(prSummary.url, p.secrets.githubToken)
    let pr = JSON.parse(resBody)

    return await checkWithHelmfile(cmd, pr, e.payload, p)
}

async function checkWithHelmfile(cmd, pr, payload, p) {
    console.log("checkWithHelmfile().p", p)
    let msg = `${cmd} started`
    let prComment = gh.post(pr.comments_url, {body: msg}, p.secrets.githubToken)

    const imageForcePull = false

    console.log("check requested")
    let desc = commands[cmd]
    // Common configuration
    const env = {
        CHECK_PAYLOAD: payload,
        CHECK_NAME: `${checkPrefix}-${cmd}`,
        // Shown in PR statuses and headers in check run details
        CHECK_TITLE: desc,
    }

    // This will represent our build job. For us, it's just an empty thinger.
    const build = command(cmd)
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

// parse parses a line of text to extract key-value pairs into a JavaScript object
function parse(line) {
    let kvs = line.split(" ")
    let dict = {}
    for (let kv of kvs) {
        let k_v = kv.split('=')
        let k = k_v[0].replace(/-/, '')
        let v = k_v[1]
        dict[k] = v
    }
    return dict
}

// toflags takes a JavaScript object and produces a line of text containing key-value pairs in space-separated `--key=value`-formatted pairs
function toflags(dict) {
    let line = ''
    for(let k of Object.keys(dict)){
        line += `--${k}=${dict[k]} `
    }
    return line
}

// CD events

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

// CD events

for (let k of kinds) {
    events.on(`${k}:apply`, handleReleaseSet(k, "apply"))
    events.on(`${k}:plan`, handleReleaseSet(k, "plan"))
    events.on(`${k}:destroy`, handleReleaseSet(k, "destroy"))
}
