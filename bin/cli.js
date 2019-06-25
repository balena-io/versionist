#!/usr/bin/env node

/*
 * Copyright 2016 Resin.io
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

/**
 * @module Versionist.CLI
 */

const childProcess = require('child_process');
const yargs = require('yargs');
const _ = require('lodash');
const async = require('async');
const path = require('path');
const chalk = require('chalk');
const versionist = require('../lib/versionist');
const semver = require('../lib/semver');
const configuration = require('../lib/cli/configuration');
const packageJSON = require('../package.json');
const debug = require('debug')(packageJSON.name);

const stopError = 'E_STOP';

const showErrorAndQuit = (error) => {
  console.error(chalk.red(error.message));
  debug(chalk.red(error.stack));
  console.error('If you run into any issues, feel free to let us know on GitHub!');
  console.error('  https://github.com/resin-io/versionist/issues');
  process.exit(1);
};

const referenceExists = (reference, callback) => {
  const child = childProcess.spawn('git', [ 'show-ref', '--quiet', reference ]);
  child.on('error', callback);
  child.on('close', (code) => {
    return callback(null, code === 0);
  });
};

const createTagFromCommit = (reference, commitSHA, callback) => {
  const child = childProcess.spawn('git', [ 'tag', reference, commitSHA ]);
  child.on('error', callback);
  child.on('close', (code) => {
    if (code !== 0) {
      return callback(null, null);
    }
    return callback(null, reference);
  });
};

const tryReferenceFromCommit = (reference, callback) => {
  let commitSHA = '';
  const child = childProcess.spawn('git', [ 'log', `--grep=^${reference}$`, '--format=%H' ]);
  child.on('error', callback);
  child.stdout.on('data', (data) => {
    commitSHA += data;
  });
  child.on('close', (code) => {
    if (commitSHA === '' || code !== 0) {
      return callback(null, null);
    }
    return createTagFromCommit(reference, _.trim(commitSHA), callback);
  });
};

const argv = yargs
  .usage('Usage: $0 [OPTIONS]')
  .help()
  .version(packageJSON.version)
  .config('config', 'configuration file', (file) => {
    // config.default returns `process.cwd()/__NO_CONFIG` if no
    // versionist.conf.js exists in the root of the repo
    let configFile = file;
    if (file.endsWith('__NO_CONFIG')) {
      configFile = {};
    } else {
      configFile = configuration.load(file);
    }
    try {
      return {
        configuration: configuration.parse(configFile)
      };
    } catch (error) {
      showErrorAndQuit(error);
    }
  })
  .options({
    patch: {
      describe: 'increment semver patch version',
      boolean: true
    },
    minor: {
      describe: 'increment semver minor version',
      boolean: true
    },
    major: {
      describe: 'increment semver major version',
      boolean: true
    },
    current: {
      describe: 'set current version',
      string: true,
      alias: 'u'
    },
    dry: {
      describe: 'Dry run',
      boolean: true,
      alias: 'd'
    },
    config: {
      describe: 'configuration file',
      alias: 'c',
      global: true,
      default: configuration.hasDefaultConfigFile(`${packageJSON.name}.conf.js`)
    },
    help: {
      describe: 'show help',
      boolean: true,
      alias: 'h'
    },
    version: {
      describe: 'show version number',
      boolean: true,
      alias: 'v'
    }
  })
  .command('get <target>', 'get latest documented version or reference', (yargsGet) => {
    yargsGet.positional('target', {
      choices: [ 'version', 'reference' ],
      describe: 'get current version or reference',
      type: 'string'
    })
    .example('$0 get version');
  })
  .example('$0 --current 1.1.0')
  .fail((message) => {

    // Prints to `stderr` by default
    yargs.showHelp();

    console.error(message);
    process.exit(1);
  })
  .argv;

async.waterfall([

  (callback) => {
    argv.configuration.getChangelogDocumentedVersions(argv.configuration.changelogFile, callback);
  },

  (documentedVersions, callback) => {
    const versions = _.attempt(() => {
      if (_.isEmpty(documentedVersions)) {
        return [ argv.configuration.defaultInitialVersion ];
      }

      return documentedVersions;
    });
    const latest = semver.getGreaterVersion(versions);
    if (argv.target === 'version') {
      console.log(latest);
      return callback(new Error(stopError));
    }

    const gitReference = argv.configuration.getGitReferenceFromVersion(latest);
    if (argv.target === 'reference') {
      console.log(gitReference);
      return callback(new Error(stopError));
    }
    return referenceExists(gitReference, (error, exists) => {
      if (error) {
        return callback(error);
      }

      if (exists) {
        return callback(null, versions, gitReference);
      }

      if (_.isEmpty(documentedVersions)) {
        return callback(null, versions, null);
      }

      // If no matching reference was found we look for a commit matching the reference
      // If we find one we create a reference to that commit and use it as our startReference
      return tryReferenceFromCommit(gitReference, (err, newReference) => {
        if (err) {
          return callback(err);
        }
        if (newReference) {
          return callback(null, versions, newReference);
        }

        return callback(new Error(`Omitting ${gitReference}. No valid git reference was found.`));
      });
    });
  },

  (documentedVersions, startReference, callback) => {
    versionist.readCommitHistory(path.join(argv.configuration.path, argv.configuration.gitDirectory), {
      startReference: startReference,
      endReference: 'HEAD',
      subjectParser: argv.configuration.subjectParser,
      bodyParser: argv.configuration.bodyParser,
      parseFooterTags: argv.configuration.parseFooterTags,
      lowerCaseFooterTags: argv.configuration.lowerCaseFooterTags
    }, (error, history) => {
      return callback(error, documentedVersions, history);
    });
  },

  (documentedVersions, history, callback) => {
    if (argv.current) {
      return callback(null, argv.current, documentedVersions, history);
    }
    return argv.configuration.getCurrentBaseVersion(documentedVersions, history, (error, current) => {
      return callback(error, current, documentedVersions, history);
    });
  },

  (currentVersion, documentedVersions, history, callback) => {
    if (argv.patch || argv.minor || argv.major) {
      argv.configuration.getIncrementLevelFromCommit = () => {
        if (argv.major) {
          return 'major';
        } else if (argv.minor) {
          return 'minor';
        } else if (argv.patch) {
          return 'patch';
        }
      };
    }
    const version = versionist.calculateNextVersion(history, {
      getIncrementLevelFromCommit: argv.configuration.getIncrementLevelFromCommit,
      currentVersion: currentVersion,
      incrementVersion: argv.configuration.incrementVersion
    });

    if (_.includes(documentedVersions, version)) {
      return callback(new Error(`No commits were annotated with a change type since version ${version}`), null);
    }

    return versionist.generateChangelog(history, {
      template: argv.configuration.template,
      includeCommitWhen: argv.configuration.includeCommitWhen,
      transformTemplateData: argv.configuration.transformTemplateData,
      transformTemplateDataAsync: argv.configuration.transformTemplateDataAsync,
      version: version
    }, (error, entry) => {
      if (error) {
        return callback(error);
      }
      return callback(null, version, entry);
    });
  },

  (version, entry, callback) => {
    if (argv.dry) {
      console.log(chalk.green(entry));
      return callback(null, version);
    } else if (argv.configuration.editChangelog) {
      argv.configuration.addEntryToChangelog(argv.configuration.changelogFile, entry, (error) => {
        return callback(error, version);
      });
    } else {
      return callback(null, version);
    }
  },

  (version, callback) => {
    if (argv.configuration.editVersion && !argv.dry) {
      if (_.isFunction(argv.configuration.updateVersion)) {
        argv.configuration.updateVersion(process.cwd(), version, callback);
      } else {
        async.applyEachSeries(argv.configuration.updateVersion, process.cwd(), version, callback);
      }
    } else {
      return callback();
    }
  }

], (error) => {
  if (error) {
    if (!(error.message === stopError)) {
      return showErrorAndQuit(error);
    }
  } else {
    console.log('Done');
  }
});

process.on('uncaughtException', showErrorAndQuit);
