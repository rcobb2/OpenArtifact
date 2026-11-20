# Power Apps Code App template

## Deployment is a manual step today

Code Apps publish only through a CLI — there is no REST API — and the
service-principal path is unreliable while `pac code push` is in preview
(Microsoft has said the npm CLI will replace it). A service principal also
cannot *create* a new code app at all; a maker has to run `pac code init` once.

So `publish_to_colgate_foundry` builds the bundle, files the gallery card as
`deploy_status: pending`, and hands these commands back to run locally:

```bash
pac auth create --deviceCode
```

```bash
pac code init --displayName "Your App Name"
```

```bash
npm run build && pa app push
```

Once it is live, update the gallery card with the app's URL:

```bash
curl -X PATCH https://foundry.colgate.edu/api/artifacts/<id> \
  -H 'Content-Type: application/json' \
  -d '{"launch_url":"https://apps.powerapps.com/play/e/<env>/a/<app>","deploy_status":"deployed"}'
```

When the npm CLI gains non-interactive auth, this moves into `publisher-mcp`
and the manual step goes away.
