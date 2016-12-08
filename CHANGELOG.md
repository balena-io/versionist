# Change Log

All notable changes to this project will be documented in this file.
This project adheres to [Semantic Versioning](http://semver.org/).

## 2.5.0 - 2016-12-08

- Add passing of commit hash to the config file, as a part of the commit object.

## 2.4.0 - 2016-12-06

- Add a `lowerCaseFooterTags` option (default is `true`) which lowercases all footer tags keys.

## 2.3.0 - 2016-12-01

- Ensure a specified config file is parsed correctly.

## 2.2.0 - 2016-11-24

- Reject non-existent git references if there are documented versions.
- Fix `parseFooterTags` not taking effect.
- Add `defaultInitialVersion` option.
- Don't throw ENOENT in `changelog-headers` preset if the changelog file doesn't exist.
- Add `incrementVersion` option hook.

## 2.1.0 - 2016-07-24

- Fix uncaught exception if current version is omitted.
- Add `transformTemplateData` option hook.
- Make sure every exception is nicely displayed.

## 2.0.0 - 2016-07-13

- Implement `fromLine` option for `addEntryToChangelog`'s `prepend` preset.
- Add support for preset options.
- Add `editVersion` option.
- Add `updateVersion` option hook.
- Add `editChangelog` option.
- Automatically infer the appropriate git commit range.
- Add `getGitReferenceFromVersion` option hook.
- Don't apply default values on boolean options explicitly set to `false`.
- Make CHANGELOG entry addition idempotent.
- Add `getChangelogDocumentedVersions` option hook.
- Add `addEntryToChangelog` option hook.
- Add `changelogFile` option.
- Normalize `--current` version before passing it to the template.

## 1.1.0 - 2016-07-08

- Add a simple default template.
- Fix `stdout maxBuffer exceeded` when parsing big logs.
- Support commits with indented bodies.
