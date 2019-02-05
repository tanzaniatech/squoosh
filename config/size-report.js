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
 * Find a match in buildInfo that looks like a match for path except a hash change.
 */
function findHashedMatch(name, buildInfo) {
  const nameParts = /^(.+\.)[a-f0-9]+(\..+)$/.exec(name);
  if (!nameParts) return;

  const pathStart = nameParts[1];
  const pathEnd = nameParts[2];
  const matchingEntry = buildInfo.find(
    entry => entry.name.startsWith(pathStart) && entry.name.endsWith(pathEnd)
  );
  return matchingEntry;
}


const buildSizePrefix = '=== BUILD SIZES: ';
const buildSizePrefixRe = new RegExp(`^${escapeRE(buildSizePrefix)}(.+)$`, 'm');

async function main() {
  // Output the current build sizes for later retrieval.
  const buildInfo = await dirToInfoArray(__dirname + '/../build');
  console.log(buildSizePrefix + JSON.stringify(buildInfo));

  // Get the previous results.
  const buildData = await getTravisJson('/repo/GoogleChromeLabs%2Fsquoosh/builds?branch.name=size-report&state=passed&limit=1');
  const jobUrl = buildData.builds[0].jobs[0]['@href'];
  const log = await getTravisText(jobUrl + '/log.txt');
  const reResult = buildSizePrefixRe.exec(log);

  console.log('\nBuild change report:');

  if (!reResult) {
    console.log(`  Couldn't find previous build info`);
    return;
  }

  let previousBuildInfo;

  try {
    previousBuildInfo = JSON.parse(reResult[1]);
  } catch (err) {
    console.log(`  Couldn't parse previous build info`);
    return;
  }

  // Entries are { beforeName, afterName, beforeSize, afterSize }.
  const buildChanges = [];
  const alsoInPreviousBuild = new Set();

  for (const oldEntry of previousBuildInfo) {
    const newEntry = buildInfo.find(entry => entry.name === oldEntry.name) ||
      findHashedMatch(oldEntry.name, buildInfo);

    if (!newEntry) {
      buildChanges.push({
        beforeName: oldEntry.name,
        beforeSize: oldEntry.gzipSize,
      });
      continue;
    }

    alsoInPreviousBuild.add(newEntry);

    if (
      oldEntry.size === newEntry.size &&
      oldEntry.name === newEntry.name
    ) continue;

    buildChanges.push({
      beforeName: oldEntry.name,
      afterName: newEntry.name,
      beforeSize: oldEntry.gzipSize,
      afterSize: newEntry.gzipSize,
    });
  }

  for (const newEntry of buildInfo) {
    if (alsoInPreviousBuild.has(newEntry)) continue;

    buildChanges.push({
      afterName: newEntry.name,
      afterSize: newEntry.gzipSize,
    });
  }

  if (buildChanges.length === 0) {
    console.log('  No changes');
    return;
  }

  // One letter references, so it's easier to get the spacing right.
  const y = chalk.yellow;
  const g = chalk.green;
  const r = chalk.red;

  for (const change of buildChanges) {
    if (change.beforeSize && change.afterSize) {
      let size;

      if (change.beforeSize === change.afterSize) {
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

      console.log(`  ${y('CHANGED')} ${change.beforeName} - ${size}`);

      if (change.beforeName !== change.afterName) {
        console.log(`    Renamed from: ${change.beforeName}`);
      }
    } else if (!change.beforeSize) {
      console.log(`  ${g('ADDED')}   ${change.afterName} - ${prettyBytes(change.afterSize)}`);
    } else {
      console.log(`  ${r('REMOVED')} ${change.beforeName} - was ${prettyBytes(change.beforeSize)}`);
    }
  }
}

main();
