const {events, Job, Group} = require("brigadier")
const gh = require("./http")
const dest = "/workspace"
const image = "mumoshu/helmfile-chatops:0.2.0"

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
    switch (comment) {
        case "/apply":
            await gh.addComment(owner, repo, issue, `Processing ${comment}`, ghtoken)
            await runGithubCheckWithHelmfile("apply", e, p)
            await gh.addComment(owner, repo, issue, `Finished processing ${comment}`, ghtoken)
            break
        default:
            if (comment.startsWith("/")) {
                await gh.addComment('mumoshu', repo, issue, `Unsupported command ${comment}`, ghtoken)
            }
            console.log(`No applicable action found for comment: ${comment}`);
    }
}

events.on("issue_comment:created", handleIssueComment);

events.on("push", (e, p) => {
    console.log("handling push....")
    console.log("payload", e.payload)
    var gh = JSON.parse(e.payload)
    if (e.type != "pull_request") {
        helmfile("apply").run()
    }
});

const checkRunImage = "brigadecore/brigade-github-check-run:latest"

events.on("check_suite:requested", checkRequested('check_suite:requested'))
events.on("check_suite:rerequested", checkRequested('check_suite:rerequested'))
events.on("check_run:rerequested", checkRequested('check_run:rerequested'))
events.on("check_run:completed", logEvent)
events.on("check_suite:completed", logEvent)

async function logEvent(e, p) {
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
        msg = `Check run [${run.name}](${run.url}) finished with \`${run.conclusion}\``
    } else {
        suite = payload.body.check_suite
        msg = `Check suite [${suite.id}](${suite.url}) finished with \`${suite.conclusion}\``
    }
    console.log('check_suite', suite)
    let prUrl = suite.pull_requests[0].url
    let resBody = await gh.get(prUrl, p.secrets.githubToken)
    let pr = JSON.parse(resBody)
    console.log('res', res)

    await gh.post(pr.comments_url, {body: msg})

    // tmp = payload.body.repository.owner.html_url.split('/')
    // let owner = tmp[tmp.length - 1]
    // let repo = payload.body.repository.name;
    // let issue = payload.body.issue.number;
    // let ghtoken = p.secrets.githubToken;
    // await gh.addComment(owner, repo, issue, `Processing ${comment}`, ghtoken)
}

function checkRequested(id) {
    return async (e, p) => {
        payload = JSON.parse(e.payload)
        console.log(`${id}.payload`, payload)
        return runGithubCheckWithHelmfile("diff", e, p)
    }
}

// runGithubCheckWithHelmfile runs `helmfile ${cmd}` within a GitHub Check, so that its status(success, failure) and logs
// are visible in the pull request UI.
async function runGithubCheckWithHelmfile(cmd, e, p) {
    const imageForcePull = false

    console.log("check requested")
    // Common configuration
    const env = {
        CHECK_PAYLOAD: e.payload,
        CHECK_NAME: `helmfile-${cmd}`,
        CHECK_TITLE: "Detected Changes",
    }

    // This will represent our build job. For us, it's just an empty thinger.
    const build = helmfile(cmd)
    build.streamLogs = true

    // For convenience, we'll create three jobs: one for each GitHub Check
    // stage.
    const start = new Job("start-run", checkRunImage)
    start.imageForcePull = imageForcePull
    start.env = env
    start.env.CHECK_SUMMARY = "Beginning test run"

    const end = new Job("end-run", checkRunImage)
    end.imageForcePull = imageForcePull
    end.env = env

    try {
        // Now we run the jobs in order:
        // - Notify GitHub of start
        // - Run the test
        // - Notify GitHub of completion
        //
        // On error, we catch the error and notify GitHub of a failure.
        let startResult = await start.run()

        // let check = JSON.parse(startResult.toString())
        console.log('check', startResult.toString())

        // In case you see errors like the below in a helmfile pod:
        //   Error: secrets is forbidden: User "system:serviceaccount:default:brigade-worker" cannot list resource "secrets" in API group "" in the namespace "kube-system"
        // It is likely you don't have correct premissions provided to the job pod that runs helmfile.
        // Run something like the below, for testing purpose:
        //   kubectl create clusterrolebinding brigade-worker-as-cluster-admin --serviceaccount default:brigade-worker --clusterrole cluster-admin
        // Hopefully you'll use something stricter in a prod env :)
        let result = await build.run()

        end.env.CHECK_CONCLUSION = "success"
        end.env.CHECK_SUMMARY = "Build completed"
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
        end.env.CHECK_SUMMARY = "Build failed"
        end.env.CHECK_TEXT = `Error: ${err}

Logs:
${logs}`
    }
    return await end.run()
}

function helmfile(cmd) {
    var job = new Job(cmd, image)
    job.tasks = [
        "mkdir -p " + dest,
        "cp -a /src/* " + dest,
        "cd " + dest,
        `variant ${cmd}`,
    ]
    return job
}
