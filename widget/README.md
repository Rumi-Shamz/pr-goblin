# pr-goblin-widget

Feedback button and bug-report form for your web app, part of [pr-goblin](https://github.com/Rumi-Shamz/pr-goblin). It sends the report, with the page URL, browser, viewport, recent console and network errors and an optional masked screenshot, to a pr-goblin intake endpoint. The endpoint turns it into a ticket that an agent can investigate and fix.

## Install

```sh
npm install pr-goblin-widget
```

```js
import PrGoblin from 'pr-goblin-widget'

PrGoblin.init({ endpoint: 'https://your-intake.example/feedback', projectName: 'My App' })
```

Or load it from a CDN, pinned to a major version:

```html
<script src="https://cdn.jsdelivr.net/npm/pr-goblin-widget@0/dist/pr-goblin.iife.js"></script>
<script>
  PrGoblin.init({ endpoint: 'https://your-intake.example/feedback', projectName: 'My App' })
</script>
```

You need an intake endpoint to receive the reports. Setting one up, the widget options and screenshot masking are covered in the [main README](https://github.com/Rumi-Shamz/pr-goblin#intake-and-widget).

## Versions

The widget is versioned with the rest of pr-goblin; see the [changelog](https://github.com/Rumi-Shamz/pr-goblin/blob/main/CHANGELOG.md). While the version is 0.x, a minor release (0.2.0) may change behaviour and lists it under **Breaking**, so `^0.1.0` takes only patch releases.

## Licence

MIT. The widget started from [bugpilot](https://github.com/rodlunt/bugpilot) by rodlunt (MIT); both licences ship in this package.
