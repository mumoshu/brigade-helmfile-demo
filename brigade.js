const { events, Job , Group} = require("brigadier")
const gh = require("./http")
const dest = "/workspace"
const image = "mumoshu/helmfile-chatops:0.2.0"

async function handleIssueComment(e, p) {
  console.log("handling issue comment....")
  payload = JSON.parse(e.payload);

  // Extract the comment body and trim whitespace
  comment = payload.body.comment.body.trim();

  console.log(p)
  console.log(payload, payload.body.repository.owner)

  await gh.addComment('mumoshu', payload.body.repository.name, payload.body.issue.number, `Processing ${comment}`, p.secrets.githubToken)

  // Here we determine if a comment should provoke an action
  switch(comment) {
    case "/apply":
      await run("apply", e, p)
      await gh.addComment('mumoshu', 'demo-78a64c769a615eb776', '2', `Finished processing ${comment}`, p.secrets.githubToken)
    default:
      console.log(`No applicable action found for comment: ${comment}`);
  }
}

events.on("issue_comment:created", handleIssueComment);

events.on("push", (e, p) => {
  console.log(e.payload)
  var gh = JSON.parse(e.payload)
  if (e.type == "pull_request") {
    //helmfile("diff").run()
  } else {
    helmfile("apply").run()
  }
});

const checkRunImage = "brigadecore/brigade-github-check-run:latest"

events.on("check_suite:requested", checkRequested)
events.on("check_suite:rerequested", checkRequested)
events.on("check_run:rerequested", checkRequested)

async function checkRequested(e, p) {
  return run("diff", e, p)
}

async function run(cmd, e, p) {
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
  start.imageForcePull = true
  start.env = env
  start.env.CHECK_SUMMARY = "Beginning test run"

  const end = new Job("end-run", checkRunImage)
  end.imageForcePull = true
  end.env = env

  // Now we run the jobs in order:
  // - Notify GitHub of start
  // - Run the test
  // - Notify GitHub of completion
  //
  // On error, we catch the error and notify GitHub of a failure.
  start.run().then(() => {
    return build.run()
  }).then( (result) => {
    end.env.CHECK_CONCLUSION = "success"
    end.env.CHECK_SUMMARY = "Build completed"
    end.env.CHECK_TEXT = result.toString()
    return end.run()
  }).catch( async (err) => {
    // logs = await build.logs()
    // In this case, we mark the ending failed.
    end.env.CHECK_CONCLUSION = "failure"
    end.env.CHECK_SUMMARY = "Build failed"
    end.env.CHECK_TEXT = `Error: ${ err }`

// Logs:
// ${ logs }`
    return end.run()
  })
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
