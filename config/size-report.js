const path = require('path');
const fs = require('fs');
const util = require('util');

const gzipSize = require('gzip-size');
const fetch = require('node-fetch');

const readdir = util.promisify(fs.readdir);

function getJson(url) {
  return fetch(url).then(r => r.json());
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
        result.push({
          name: namePrefix + entry.name,
          gzipSize: await gzipSize.file(entryPath),
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


const buildSizePrefix = '=== BUILD SIZES: ';
const buildSizePrefixRe = /^=== BUILD SIZES: (.+)$/m;

async function main() {
  // Output the current build sizes for later retrieval.
  const buildInfo = await dirToInfoArray(__dirname + '/../build');
  console.log(buildSizePrefix + JSON.stringify(buildInfo));

  // Get the previous results.
  const branchData = await getJson('https://api.travis-ci.org/repos/GoogleChromeLabs/squoosh/branches/size-report');
  const jobId = branchData.branch.job_ids[0];
  const { log } = await getJson(`https://api.travis-ci.org/jobs/${jobId}`);
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

  // Entries are { name, beforeSize, afterSize }.
  const buildChanges = [];
  const alsoInPreviousBuild = new Set();

  for (const oldEntry of previousBuildInfo) {
    const newEntry = buildInfo.find(entry => entry.name === oldEntry.name);

    if (!newEntry) {
      buildChanges.push({
        name: oldEntry.name,
        beforeSize: oldEntry.gzipSize,
      });
    } else {
      alsoInPreviousBuild.add(newEntry);

      if (oldEntry.gzipSize !== newEntry.gzipSize) {
        buildChanges.push({
          name: oldEntry.name,
          beforeSize: oldEntry.gzipSize,
          afterSize: newEntry.gzipSize,
        });
      }
    }
  }

  for (const newEntry of buildInfo) {
    if (alsoInPreviousBuild.has(newEntry)) continue;
    buildChanges.push({
      name: newEntry.name,
      afterSize: newEntry.gzipSize,
    });
  }

  if (buildChanges.length === 0) {
    console.log('  No changes');
    return;
  }

  // Sort into name order. This makes it easier to compare files that have changed hash.
  buildChanges.sort((a, b) => a.name > b.name ? 1 : -1);

  for (const change of buildChanges) {
    if (change.beforeSize && change.afterSize) {
      console.log(`  CHANGED ${change.name} ${change.beforeSize} -> ${change.afterSize}`);
    } else if (!change.beforeSize) {
      console.log(`  ADDED   ${change.name} ${change.afterSize}`);
    } else {
      console.log(`  REMOVED ${change.name} ${change.beforeSize}`);
    }
  }
}

main();
