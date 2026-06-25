# Render Keep-Alive

Use an external scheduler to ping your deployed backend health endpoint so the Render service stays warm.

## Health URL

Use your deployed Render backend health endpoint:

```text
https://your-render-service.onrender.com/health
```

Do not use the base URL alone. Use the `/health` endpoint because your backend already supports it in `src/server.js`.

## cron-job.org Setup

Use this if you want the keep-alive to run outside GitHub.

1. Sign in at `https://cron-job.org/`.
2. Create a new cronjob.
3. Set the request URL to your Render health endpoint, for example:

```text
https://sefa-backend.onrender.com/health
```

4. Use these settings:

- Method: `GET`
- Schedule: every `10 minutes`
- Timeout: default is fine
- Notifications: optional, but useful for failures

5. Save the job.
6. Run a test execution once to confirm it returns `200 OK`.

According to cron-job.org's public site and FAQ, it supports scheduled HTTP requests as often as once per minute, custom request methods, execution history, and failure notifications. Their FAQ also notes requests time out after 30 seconds, which is fine for your lightweight health endpoint. Sources:
- https://cron-job.org/
- https://cron-job.org/en/faq/

## GitHub Actions Setup

This project includes a scheduled workflow at `.github/workflows/render-keep-alive.yml`.

1. Push this project to GitHub.
2. Open your repository on GitHub.
3. Go to `Settings > Secrets and variables > Actions`.
4. Create a new repository secret named `RENDER_BACKEND_HEALTH_URL`.
5. Set the secret value to your real Render URL, for example:

```text
https://sefa-backend.onrender.com/health
```

6. Go to the `Actions` tab and enable workflows if GitHub asks.

The workflow will ping your backend every 10 minutes and can also be run manually with `workflow_dispatch`.

## Important Note

A cron job running inside the same Render web service cannot wake that service after it has gone idle. The ping must come from outside Render, which is why this GitHub Actions workflow is the right place for it.
