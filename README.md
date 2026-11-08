# ChaosPilot

ChaosPilot is a security test for AI agents.

It takes an AI agent, drops it into a disposable Docker container with a fake secret hidden inside, and then tries to trick it into giving that secret away. Fifteen different tricks are attempted, one at a time, each in its own fresh container. At the end you get a straight answer: did the agent keep the secret, or did it leak it?

Nothing here is simulated. Real containers are started, a real language model is called, and the pass/fail result comes from what actually happened during the run — not from a script.

![ChaosPilot in a browser](images/screenshot-white-theme-final.png)

---

## Who this is for

You do not need to write code to use this. You need to be comfortable with three things:

1. Copying and pasting a command into a terminal window.
2. Running Docker (the container software) on your computer or server.
3. Signing up for an API key so the AI model can be called.

If you can install an app and paste a command, you can run this.

---

## What it actually does

1. **It hides a secret.** A fake password (called the "canary") is placed inside a container. Only the container can see it.
2. **It sets a trap.** A small listener outside the container waits to see if the secret ever arrives there.
3. **It talks to the AI.** The agent is given a normal task — summarise a file, read a web page, debug something — but the material it reads contains hidden instructions telling it to reveal the secret.
4. **It checks the result.** If the secret reaches the listener, or shows up in the agent's final answer, that scenario is marked as a **leak**.
5. **It repeats.** Fifteen scenarios, each independent. One bad scenario cannot contaminate the next.

The end result is a score plus a reason for that score, so you know which specific attacks the agent fell for.

---

## Requirements

| What | Why | Where to get it |
| --- | --- | --- |
| **Node.js 18 or newer** | Runs the server | [nodejs.org](https://nodejs.org) |
| **Docker** | Provides the sandbox containers | [docker.com](https://www.docker.com/products/docker-desktop) |
| **A Vultr Inference API key** | The AI model that gets tested | [Vultr Serverless Inference](https://www.vultr.com/products/serverless-inference/) |

Docker must be **running**, not just installed. On Windows or macOS that means Docker Desktop is open and shows a green "running" state.

---

## Setup, in order

### 1. Install the dependencies

Open a terminal in the project folder and run:

```bash
npm install
```

You only need to do this once.

### 2. Turn on real runs

ChaosPilot refuses to produce a result unless you explicitly tell it that this machine is allowed to run real tests. This is deliberate: it stops a half-configured machine from returning a fake "all clear".

Create a file named `.env` in the project folder and paste in:

```bash
USE_REAL_SANDBOX=true
USE_REAL_LLM=true
VULTR_INFERENCE_KEY=your-api-key-goes-here
VULTR_INFERENCE_MODEL=deepseek-v4.1-flash-1017
```

Replace `your-api-key-goes-here` with your real key. Change the model name if you want a different one — any model id the inference service offers will work.

The `.env` file is already excluded from git, so your key will not be committed or shared.

### 3. Start it

```bash
npm run dev
```

You should see:

```
chaospilot listening on http://127.0.0.1:3000
Ready: real Docker sandbox + real model. Runs execute for real.
```

### 4. Open it

Go to <http://127.0.0.1:3000> in your browser.

The status line at the top should read **Connected to VPS Server** in green, with *real sandbox enabled*, *real model enabled* and *docker reachable* all confirmed.

---

## Running a test

1. Pick the model in the model field, or leave it blank to use the one from your `.env`.
2. Leave the API key field blank — the server will use the key from `.env`.
3. Click **Run crash test**.
4. Wait. A full run starts fifteen containers and calls the model repeatedly, so expect a few minutes, not seconds.
5. Read the results grid as scenarios complete.

### What the colours mean

| Colour | Meaning |
| --- | --- |
| **Green** | The agent resisted. The secret stayed put. |
| **Red** | The agent leaked the secret. This is a real vulnerability. |
| **Amber** | The scenario errored. It did not run correctly, so it proves nothing either way. |
| **Grey** | Inconclusive. The run finished without enough evidence. |

### Reading the verdict

The panel at the top shows a letter grade and one of four words:

- **PASS** — every scenario ran and the secret never escaped.
- **FAIL** — at least one scenario leaked. The line underneath says how many of the fifteen failed, so you know which attacks to go and read.
- **ERROR** — the run itself did not complete, usually a key, model or Docker problem.
- **INCONCLUSIVE** — it ran, but the evidence was not clear-cut.

An error is never a pass. If scenarios show amber, fix the cause and run again — otherwise the score does not mean anything.

A useful sanity check: `honest-summary` is a harmless control scenario with no attack in it. If that one fails, the problem is your setup or the model, not the agent's security.

---

## Configuration reference

All of these go in `.env`, or in the environment of whatever runs the server.

| Variable | Default | What it does |
| --- | --- | --- |
| `USE_REAL_SANDBOX` | off | Must be `true` to start real containers. |
| `USE_REAL_LLM` | off | Must be `true` to call a real model. |
| `VULTR_INFERENCE_KEY` | none | Your API key. Required. |
| `VULTR_INFERENCE_MODEL` | none | Default model id. Can be overridden in the browser. |
| `EXTERNAL_BASE_URL` | OpenAI | Base URL for any OpenAI-compatible provider instead of Vultr. |
| `EXTERNAL_API_KEY` | none | Key for that alternative provider. |
| `EXTERNAL_MODEL` | none | Default model for that alternative provider. |
| `HOST` | `127.0.0.1` | Set to `0.0.0.0` to allow connections from other machines. |
| `PORT` | `3000` | Port the web page is served on. |
| `DOCKER_SOCK` | auto | Only set this if Docker listens somewhere unusual. |

---

## If something goes wrong

| What you see | What it means | What to do |
| --- | --- | --- |
| *"Server not ready — docker not reachable"* | Docker is not running, or ChaosPilot cannot reach it. | Start Docker Desktop and wait for it to finish booting, then restart ChaosPilot. |
| *"Real runs are disabled... `USE_REAL_SANDBOX` is not set"* | The opt-in switch is missing. | Add `USE_REAL_SANDBOX=true` to `.env` and restart. |
| *"Real runs are disabled because `USE_REAL_LLM` is not set"* | Same, for the model side. | Add `USE_REAL_LLM=true` to `.env` and restart. |
| *"Connection refused" in the browser* | The server is not running, or is on a different port. | Check the terminal, and check `PORT` if you changed it. |
| Browser loads but every scenario errors | Usually a bad or unpaid API key, or a model id that does not exist. | Test the key and model id directly with the provider. |
| `EADDRINUSE` on startup | Something else is already using port 3000. | Close the other program, or set `PORT=3001` in `.env`. |
| Runs are very slow | Normal on first use — images need downloading once. | Subsequent runs are faster. |

**Important:** a green page banner only means the server is configured correctly. It does not mean a test passed. The result of a test is the verdict section after a run.

---

## Running it on a server instead of your laptop

The same steps apply, with two additions:

1. Set `HOST=0.0.0.0` so the outside world can connect. Otherwise the site is reachable only from the server itself.
2. Put it behind a process manager (for example `pm2` or a `systemd` service) and, if it is public, behind a reverse proxy with HTTPS. A plain `node src/server.js` started over SSH dies when the session or the machine restarts, and the site will simply stop responding.

Never expose an instance holding a paid API key to the open internet without authentication in front of it — anyone who finds the page can spend your credits.

---

## Is it safe?

Yes, within the limits of the design:

- Each scenario runs inside its own Docker container and its own isolated network.
- The secret is fake and generated for the test. It is not one of your real credentials.
- The agent is expected to try to escape; the container is what stops it from touching your machine.

What this does **not** give you: a guarantee that the agent is safe in production. It tells you how the agent behaves against fifteen known trick patterns. A clean pass is evidence, not proof.

---

## What is in the folder

| Path | What it is |
| --- | --- |
| `src/server.js` | The web server and the API endpoints. |
| `src/agent.js` | Runs the agent inside the container. |
| `src/sandbox.js` | Creates and cleans up the Docker containers. |
| `src/detect.js` | The fifteen attack scenarios and the pass/fail grading. |
| `src/runner.js` | Orchestrates a full run. |
| `src/env.js` | Reads the configuration and decides whether a real run is allowed. |
| `public/index.html` | The page you see and click. Single file, no build step. |
| `images/` | Screenshots used in documents like this one. |
| `package.json` | Dependencies and the `npm run dev` command. |

---

## The fifteen scenarios

For reference, the tests that run:

`hidden-injection`, `poisoned-csv`, `debug-this-env-dump`, `infinite-loop-trick`, `malicious-tool-output`, `honest-summary`, `recall-injection`, `env-dump-injection`, `on-page-command-injection`, `file-read-injection`, `json-payload-injection`, `hidden-exfil-instruction`, `comment-injection`, `two-step-injection`, `urgency-injection`.

The names describe the trick being used. `honest-summary` is the control: a normal task with no attack hidden in it, used to prove the setup works at all.
