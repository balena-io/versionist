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
 * @module Versionist.Presets
 */

const _ = require('lodash');
const async = require('async');
const touch = require('touch');
const path = require('path');
const updateJSON = require('update-json');
const fs = require('fs');
const semver = require('semver');
const semverUtils = require('./semver');
const replaceInFile = require('replace-in-file');
const markdown = require('./markdown');
const yaml = require('js-yaml');
const octokit = require('@octokit/rest')({
  debug: Boolean(process.env.DEBUG)
});

const authenticate = () => {
  octokit.authenticate({
    type: 'token',
    token: process.env.GITHUB_TOKEN
  });
};

const extractContentsBetween = (changelog, repo, start, end) => {
  return _(changelog)
  .filter((entry) => {
    return semverUtils.leq(start, entry.version) && semverUtils.leq(entry.version, end);
  })
  .map((entry) => {
    entry.version = `${repo}-${entry.version}`;
    return entry;
  })
  .value();
};

const getNestedChangeLog = (options, commit, startVersion, endVersion, callback) => {
  const {
    owner,
    repo,
    ref
  } = options;

  authenticate();

  octokit.repos.getContent({
    owner: owner,
    repo: repo,
    ref: ref,
    path: '.versionbot/CHANGELOG.yml'
  }, (error, response) => {
    if (error) {
      return callback(new Error(`Could not find .versionbot/CHANGELOG.yml in ${repo}`));
    }
    
	// content will be base64 encoded
    const changelog = yaml.safeLoad(Buffer.from(response.data.content, 'base64').toString());
    commit.nested = extractContentsBetween(changelog, repo, startVersion, endVersion);
    return callback(null, commit);
  });
};

/**
 * @summary Replaces the contents of a file using a regular expression
 * @function
 * @private
 *
 * @param {String} file - target filename
 * @param {RegExp} pattern - pattern used in str.replace
 * @param {String} replacement - replacement used in str.replace
 * @param {Function} callback - callback (error)
 */
const replace = (file, pattern, replacement, callback) => {
  async.waterfall([
    (done) => {
      fs.readFile(file, 'utf8', done);
    },

    (contents, done) => {
      if (pattern.test(contents)) {
        done(null, contents);
      } else {
        done(new Error(`Pattern does not match ${file}`));
      }
    },

    (contents, done) => {
      const updated = contents.replace(pattern, replacement);
      done(null, updated);
    },

    _.partial(fs.writeFile, file)
  ], callback);
};

/**
 * @summary Returns an appropriate function to clean the version
 * @function
 * @private
 *
 * @param {Object} options - Full options object
 * @param {Boolean|RegExp} [options.clean] - If true semver.clean is returned, if a
 * regexp is supplied, a function that replaces every match with the empty string is returned.
 * If false the identity function is returned.
 * @returns {Function}
 */
const getCleanFunction = (options) => {
  _.defaults(options, {
    clean: true
  });

  if (_.isRegExp(options.clean)) {
    return (version) => {
      return version.replace(options.clean, '');
    };
  }
  return options.clean ? semver.clean : _.identity;
};

module.exports = {

  subjectParser: {

    /**
     * @summary Angular's `subjectParser`
     * @function
     * @public
     *
     * @description
     * Based on https://github.com/angular/angular.js/blob/master/CONTRIBUTING.md
     *
     * @param {Object} options - options
     * @param {String} subject - commit subject
     * @returns {Object} parsed subject
     *
     * @example
     * const subject = presets.subjectParser.angular({}, 'feat($ngInclude): lorem ipsum');
     *
     * console.log(subject.type);
     * > feat
     * console.log(subject.scope);
     * > $ngInclude
     * console.log(subject.title);
     * > lorem ipsum
     */
    angular: (options, subject) => {
      const subjectParts = subject.match(/^(?:fixup!\s*)?(\w*)(\(([\w$.*/-]*)\))?: (.*)$/);

      return {
        type: _.nth(subjectParts, 1),
        scope: _.nth(subjectParts, 3),
        title: _.nth(subjectParts, 4) || subject
      };
    }

  },

  includeCommitWhen: {

    /**
     * @summary Angular's `includeCommitWhen`
     * @function
     * @public
     *
     * @description
     * Based on https://github.com/angular/angular.js/blob/master/changelog.js
     *
     * @param {Object} options - options
     * @param {Object} commit - commit
     * @returns {Boolean} whether the commit should be included
     *
     * @example
     * if (presets.includeCommitWhen.angular({}, {
     *   subject: {
     *     type: 'feat'
     *   }
     * })) {
     *   console.log('The commit should be included');
     * }
     *
     * @example
     * if (presets.includeCommitWhen.angular({}, {
     *   subject: 'feat(Scope): my commit'
     * })) {
     *   console.log('The commit should be included');
     * }
     */
    angular: (options, commit) => {
      if (_.isString(commit.subject)) {
        return _.some([
          _.startsWith(commit.subject, 'feat'),
          _.startsWith(commit.subject, 'fix'),
          _.startsWith(commit.subject, 'perf')
        ]);
      }

      return _.includes([
        'feat',
        'fix',
        'perf'
      ], commit.subject.type);
    }

  },

  getChangelogDocumentedVersions: {

    /**
     * @summary Get CHANGELOG documented versions from CHANGELOG titles
     * @function
     * @public
     *
     * @param {Object} options - options
     * @param {String} file - changelog file
     * @param {Function} callback - callback (error, versions)
     *
     * @example
     * presets.getChangelogDocumentedVersions['changelog-headers']({}, 'CHANGELOG.md', (error, versions) => {
     *
     *   if (error) {
     *     throw error;
     *   }
     *
     *   console.log(versions);
     * });
     */
    'changelog-headers': (options, file, callback) => {
      const cleanFn = getCleanFunction(options);

      fs.readFile(file, {
        encoding: 'utf8'
      }, (error, changelog) => {
        if (error) {
          if (error.code === 'ENOENT') {
            return callback(null, []);
          }

          return callback(error);
        }

        const versions = _.chain(markdown.extractTitles(changelog))
          .map((title) => {
            return _.filter(_.split(title, ' '), semver.valid);
          })
          .flattenDeep()
          .map(cleanFn)
          .value();

        return callback(null, versions);
      });
    }

  },

  getCurrentBaseVersion: {
    /**
     * @summary Get greater semantic version from documentedVersions
     * @function
     * @public
     *
     * @param {Object} options - options
     * @param {String[]} documentedVersions - documented versions
     * @param {Object[]} history - relevant commit history
     * @param {Function} callback - callback
     * @returns {String} version
     *
     * @example
     * const version = presets.getCurrentBaseVersion['latest-documented']({}, [
     *   '2.1.1',
     *   '2.1.0',
     *   '2.0.0'
     * ], [], (version) => {
     *  console.log(version)
     *  > 2.1.1
     * });
     *
     */
    'latest-documented': (options, documentedVersions, history, callback) => {
      return callback(null, semverUtils.getGreaterVersion(documentedVersions));
    }
  },

  addEntryToChangelog: {

    /**
     * @summary Prepend entry to CHANGELOG
     * @function
     * @public
     *
     * @param {Object} options - options
     * @param {Number} [options.fromLine=0] - prepend from line
     * @param {String} file - changelog file path
     * @param {String} entry - changelog entry
     * @param {Function} callback - callback
     *
     * @example
     * presets.addEntryToChangelog.prepend({}, 'changelog.md', 'My Entry\n', (error) => {
     *   if (error) {
     *     throw error;
     *   }
     * });
     */
    prepend: (options, file, entry, callback) => {
      _.defaults(options, {
        fromLine: 0
      });

      async.waterfall([
        _.partial(touch, file, {}),

        (touchedFiles, done) => {
          fs.readFile(file, {
            encoding: 'utf8'
          }, done);
        },

        (contents, done) => {
          const changelogLines = _.split(contents, '\n');

          return done(null, _.join(_.reduce([
            _.slice(changelogLines, 0, options.fromLine),
            _.split(entry, '\n'),
            _.slice(changelogLines, options.fromLine)
          ], (accumulator, array) => {
            const head = _.dropRightWhile(accumulator, _.isEmpty);
            const body = _.dropWhile(array, _.isEmpty);

            if (_.isEmpty(head)) {
              return body;
            }

            return _.concat(head, [ '' ], body);
          }, []), '\n'));
        },

        _.partial(fs.writeFile, file)
      ], callback);
    }
  },

  transformTemplateDataAsync: {
    'nested-changelogs': (options, data, callback) => {
      const regexp = new RegExp(`Update ${options.repo} from (\\S+) to (\\S+)`);
      
      async.map(data.commits, (commit, cb) => {
        const match = commit.body.match(regexp);
        if (match) {
          const currentVersion = match[1];
          const targetVersion = match[2];
          return getNestedChangeLog(options, commit, currentVersion, targetVersion, cb);
        }
        return cb(null, commit);
      }, (err, commits) => {
        if (err) {
          return callback(err);
        }
        data.commits = commits;

        return callback(err, data);
      });
    }
  },

  getGitReferenceFromVersion: {

    /**
     * @summary Add a `v` prefix to the version
     * @function
     * @public
     *
     * @param {Object} options - options
     * @param {String} version - version
     * @returns {String} git reference
     *
     * @example
     * const reference = presets.getGitReferenceFromVersion['v-prefix']({}, '1.0.0');
     * console.log(reference);
     * > v1.0.0
     */
    'v-prefix': (options, version) => {
      if (_.startsWith(version, 'v')) {
        return version;
      }

      return `v${version}`;
    }

  },

  updateVersion: {

    /**
     * @summary Update NPM version
     * @function
     * @public
     *
     * @param {Object} options - options
     * @param {Boolean|RegExp} [options.clean=true] - determines how to sanitise the version
     * @param {String} cwd - current working directory
     * @param {String} version - version
     * @param {Function} callback - callback (error)
     * @returns {null}
     *
     * @example
     * presets.updateVersion.npm({}, process.cwd(), '1.0.0', (error) => {
     *   if (error) {
     *     throw error;
     *   }
     * });
     */
    npm: (options, cwd, version, callback) => {
      const cleanFn = getCleanFunction(options);
      const packageJSON = path.join(cwd, 'package.json');
      const cleanedVersion = cleanFn(version);

      if (!cleanedVersion) {
        return callback(new Error(`Invalid version: ${version}`));
      }

      updateJSON(packageJSON, {
        version: cleanedVersion
      }, (error) => {
        if (error && error.code === 'ENOENT') {
          error.message = `No such file or directory: ${packageJSON}`;
        }

        return callback(error);
      });
    },

    /**
     * @summary Update Rust Cargo crate version
     * @function
     * @public
     *
     * @param {Object} options - options
     * @param {Boolean|RegExp} [options.clean=true] - determines how to sanitise the version
     * @param {String} cwd - current working directory
     * @param {String} version - version
     * @param {Function} callback - callback (error)
     * @returns {null}
     *
     * @example
     * presets.updateVersion.cargo({}, process.cwd(), '1.0.0', (error) => {
     *   if (error) {
     *     throw error;
     *   }
     * });
     */
    cargo: (options, cwd, version, callback) => {
      const cleanFn = getCleanFunction(options);
      const cargoToml = path.join(cwd, 'Cargo.toml');
      const cargoLock = path.join(cwd, 'Cargo.lock');

      const cleanedVersion = cleanFn(version);

      if (!cleanedVersion) {
        return callback(new Error(`Invalid version: ${version}`));
      }

      async.waterfall([
        (done) => {
          return fs.readFile(cargoToml, 'utf8', done);
        },

        (contents, done) => {
          // Capture first `name = "..."` occurrence immediately after `[package]`
          const matches = contents.match(/\[package\][^[]+?name\s*=\s*("|')(.+?)\1/m);
          if (_.isNull(matches)) {
            done(new Error(`Package name not found in ${cargoToml}`));
          } else {
            done(null, matches[2]);
          }
        },

        (packageName, done) => {
          if (fs.existsSync(cargoLock)) {
            // Update first `version = "..."` occurrence immediately after `name = "${packageName}"`
            replace(
              cargoLock,
              new RegExp(`(name\\s*=\\s*(?:"|')${packageName}(?:"|')[^[]+?version\\s*=\\s*)("|').*?\\2`, 'm'),
              '$1$2' + cleanedVersion + '$2',
              done
            );
          } else {
            done(null);
          }
        },

        (done) => {
          // Update first `version = "..."` occurrence immediately after `[package]`
          replace(
            cargoToml,
            /(\[package\][^[]+?version\s*=\s*)("|').*?\2/m,
            '$1$2' + cleanedVersion + '$2',
            done
          );
        }
      ], callback);
    },

    /**
     * @summary Update package version in Python Init file
     * @function
     * @public
     *
     * @param {Object} options - options
     * @param {String} [options.targetFile] - path to target python file, defaults to `__init__.py`
     * @param {Boolean|RegExp} [options.clean=true] - determines how to sanitise the version
     * @param {String} cwd - current working directory
     * @param {String} version - version
     * @param {Function} callback - callback (error)
     * @returns {null}
     *
     * @example
     * presets.updateVersion.initPy({}, process.cwd(), '1.0.0', (error) => {
     *   if (error) {
     *     throw error;
     *   }
     * });
     */
    initPy: (options, cwd, version, callback) => {
      _.defaults(options, {
        targetFile: '__init__.py'
      });

      const cleanFn = getCleanFunction(options);
      const initFile = path.join(cwd, options.targetFile);
      const cleanedVersion = cleanFn(version);

      if (!cleanedVersion) {
        return callback(new Error(`Invalid version: ${version}`));
      }

      replaceInFile({
        files: initFile,
        from: /(__version__\s*=\s*)('|")(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\2/g,
        to: '$1$2' + cleanedVersion + '$2'
      }, (error) => {
        if (error) {
          return callback(error);
        }
      });
    },

    /**
     * @summary Update quoted version immediately following a regex
     * @function
     * @public
     *
     * @param {Object} options - options
     * @param {String} [options.baseDir] - relative directory to append to cwd
     * @param {String} options.file - file to modify
     * @param {String} options.regex - regex leading up to the quoted version string
     * @param {String} [options.regexFlags] - any modifier flags as used in RegExp
     * @param {Boolean|RegExp} [options.clean=true] - determines how to sanitise the version
     * @param {String} cwd - current working directory
     * @param {String} version - version
     * @param {Function} callback - callback (error)
     * @returns {null}
     *
     * @example
     * presets.updateVersion.quoted({
     *   file: 'myfile.h',
     *   regex: /^VERSION\s+=\s+/,
     *   regexFlags: 'm'
     * }, process.cwd(), '1.0.0', (error) => {
     *   if (error) {
     *     throw error;
     *   }
     * });
     */
    quoted: (options, cwd, version, callback) => {
      _.defaults(options, {
        baseDir: '.',
        regexFlags: ''
      });

      if (path.isAbsolute(options.baseDir)) {
        return callback(new Error('baseDir option can\'t be an absolute path'));
      }
      if (_.isUndefined(options.file)) {
        return callback(new Error('Missing file option'));
      }
      if (path.isAbsolute(options.file)) {
        return callback(new Error('file option can\'t be an absolute path'));
      }
      if (_.isUndefined(options.regex)) {
        return callback(new Error('Missing regex option'));
      }

      const updateFile = path.join(cwd, options.baseDir, options.file);
      const cleanFn = getCleanFunction(options);

      const cleanedVersion = cleanFn(version);

      if (!cleanedVersion) {
        return callback(new Error(`Invalid version: ${version}`));
      }

      const innerRegex = RegExp(options.regex);
      const combinedRegexSource = '(' + innerRegex.source + ')("|\').*?\\2';
      const combinedRegexFlags = _.join(_.uniqBy(innerRegex.flags + options.regexFlags), '');

      replace(
        updateFile,
        new RegExp(combinedRegexSource, combinedRegexFlags),
        '$1$2' + cleanedVersion + '$2',
        callback
      );
    }
  },

  incrementVersion: {

    /**
     * @summary Increment a version following semver
     * @function
     * @public
     *
     * @param {Object} options - options
     * @param {String} version - original version
     * @param {String} incrementLevel - increment level
     * @returns {String} incremented version
     *
     * @example
     * const version = presets.incrementVersion.semver({}, '1.0.0', 'major');
     * console.log(version);
     * > 2.0.0
     */
    semver: (options, version, incrementLevel) => {
      if (!semver.valid(version)) {
        throw new Error(`Invalid version: ${version}`);
      }

      const incrementedVersion = semver.inc(version, incrementLevel);

      if (!incrementedVersion) {
        throw new Error(`Invalid increment level: ${incrementLevel}`);
      }

      return incrementedVersion;
    }

  }

};
