const path = require('path');
const fs = require('fs');
const util = require('util');

const gzipSize = require('gzip-size');
const fetch = require('node-fetch');
const prettyBytes = require('pretty-bytes');
const escapeRE = require('escape-string-regexp');
const chalk = new require('chalk').constructor({ level: 4 });

const readdir = util.promisify(fs.readdir);
const stat = util.promisify(fs.stat);

function getTravis(path) {
  return fetch('https://api.travis-ci.org' + path, {
    headers: { 'Travis-API-Version': '3' },
  });
}

function getTravisJson(path) {
  return getTravis(path).then(r => r.json());
}

function getTravisText(path) {
  return getTravis(path).then(r => r.text());
}

/**
 * Recursively-read a directory and turn it into an array of { name, size, gzipSize }
 */
async function dirToInfoArray(startPath, {
  namePrefix = '',
} = {}) {
  const entries = await readdir(startPath, { withFileTypes: true });
  const promises = [];
  const result = [];

  for (const entry of entries) {
    const entryPath = path.join(startPath, entry.name);
    if (entry.isFile()) {
      promises.push(async function() {
        const gzipPromise = gzipSize.file(entryPath);
        const statPromise = stat(entryPath);

        result.push({
          name: namePrefix + entry.name,
          gzipSize: await gzipPromise,
          size: (await statPromise).size,
        });
      }());
    } else if (entry.isDirectory()) {
      promises.push(async function() {
        const dirResult = await dirToInfoArray(entryPath, {
          namePrefix: entry.name + '/',
        });

        result.push(...dirResult);
      }());
    }
  }

  await Promise.all(promises);
  return result;
}

/**
 * Try to treat two entries with different file name hashes as the same file.
 */
function findHashedMatch(name, buildInfo) {
  const nameParts = /^(.+\.)[a-f0-9]+(\..+)$/.exec(name);
  if (!nameParts) return;

  const matchRe = new RegExp(`^${escapeRE(nameParts[1])}[a-f0-9]+${escapeRE(nameParts[2])}$`);
  const matchingEntry = buildInfo.find(entry => matchRe.test(entry.name));
  return matchingEntry;
}

const buildSizePrefix = '=== BUILD SIZES: ';
const buildSizePrefixRe = new RegExp(`^${escapeRE(buildSizePrefix)}(.+)$`, 'm');

async function getPreviousBuildInfo() {
  const buildData = await getTravisJson('/repo/GoogleChromeLabs%2Fsquoosh/builds?branch.name=size-report&state=passed&limit=1');
  const jobUrl = buildData.builds[0].jobs[0]['@href'];
  const log = await getTravisText(jobUrl + '/log.txt');
  const reResult = buildSizePrefixRe.exec(log);

  if (!reResult) return;
  return JSON.parse(reResult[1]);
}

/**
 * Generate an array that represents the difference between builds.
 * Returns an array of { beforeName, afterName, beforeSize, afterSize }.
 * Sizes are gzipped size.
 * Before/after properties are missing if resource isn't in the previous/new build.
 */
function getChanges(previousBuildInfo, buildInfo) {
  const buildChanges = [];
  const alsoInPreviousBuild = new Set();

  for (const oldEntry of previousBuildInfo) {
    const newEntry = buildInfo.find(entry => entry.name === oldEntry.name) ||
      findHashedMatch(oldEntry.name, buildInfo);

    // Entry is in previous build, but not the new build.
    if (!newEntry) {
      buildChanges.push({
        beforeName: oldEntry.name,
        beforeSize: oldEntry.gzipSize,
      });
      continue;
    }

    // Mark this entry so we know we've dealt with it.
    alsoInPreviousBuild.add(newEntry);

    // If they're the same, just ignore.
    // Using size rather than gzip size. I've seen different platforms produce different zipped
    // sizes.
    if (
      oldEntry.size === newEntry.size &&
      oldEntry.name === newEntry.name
    ) continue;

    // Entry is in both builds (maybe renamed).
    buildChanges.push({
      beforeName: oldEntry.name,
      afterName: newEntry.name,
      beforeSize: oldEntry.gzipSize,
      afterSize: newEntry.gzipSize,
    });
  }

  // Look for entries that are only in the new build.
  for (const newEntry of buildInfo) {
    if (alsoInPreviousBuild.has(newEntry)) continue;

    buildChanges.push({
      afterName: newEntry.name,
      afterSize: newEntry.gzipSize,
    });
  }

  return buildChanges;
}

async function main() {
  // Output the current build sizes for later retrieval.
  const buildInfo = await dirToInfoArray(__dirname + '/../build');
  console.log(buildSizePrefix + JSON.stringify(buildInfo));
  console.log('\nBuild change report:');

  let previousBuildInfo;

  try {
    previousBuildInfo = await getPreviousBuildInfo();
  } catch (err) {
    console.log(`  Couldn't parse previous build info`);
    return;
  }

  if (!previousBuildInfo) {
    console.log(`  Couldn't find previous build info`);
    return;
  }

  const buildChanges = getChanges(buildInfo, previousBuildInfo);

  if (buildChanges.length === 0) {
    console.log('  No changes');
    return;
  }

  // One letter references, so it's easier to get the spacing right.
  const y = chalk.yellow;
  const g = chalk.green;
  const r = chalk.red;

  for (const change of buildChanges) {
    // New file.
    if (!change.beforeSize) {
      console.log(`  ${g('ADDED')}   ${change.afterName} - ${prettyBytes(change.afterSize)}`);
      continue;
    }

    // Removed file.
    if (!change.afterSize) {
      console.log(`  ${r('REMOVED')} ${change.beforeName} - was ${prettyBytes(change.beforeSize)}`);
      continue;
    }

    // Changed file.
    let size;

    if (change.beforeSize === change.afterSize) {
      // Just renamed.
      size = `${prettyBytes(change.afterSize)} -> no change`;
    } else {
      const color = change.afterSize > change.beforeSize ? r : g;
      const sizeDiff = prettyBytes(change.afterSize - change.beforeSize, { signed: true });
      const percent = Math.round((change.afterSize / change.beforeSize) * 10000) / 100;

      size = `${prettyBytes(change.beforeSize)} -> ${prettyBytes(change.afterSize)}` +
        ' (' +
        color(`${sizeDiff}, ${percent}%`) +
        ')';
    }

    console.log(`  ${y('CHANGED')} ${change.afterName} - ${size}`);

    if (change.beforeName !== change.afterName) {
      console.log(`    Renamed from: ${change.beforeName}`);
    }
  }
}

main();
