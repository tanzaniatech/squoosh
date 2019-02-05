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
  const result = await dirToInfoArray(__dirname + '/../build');
  console.log(buildSizePrefix + JSON.stringify(result));
  return;

  // Get the previous results.
  const branchData = await getJson('https://api.travis-ci.org/repos/GoogleChromeLabs/squoosh/branches/size-report');
  const jobId = branchData.branch.job_ids[0];
  const { log } = await getJson(`https://api.travis-ci.org/jobs/${jobId}`);
  const reResult = buildSizePrefixRe.exec(log);

  console.log('\nBuild change report:');

  if (!reResult) {
    console.log(`Couldn't find previous build info`);
    return;
  }

  let previousResult;

  try {
    previousResult = JSON.parse(reResult[1]);
  } catch (err) {
    console.log(`Couldn't parse previous build info`);
    return;
  }

  // { path: entry }
  const deleted = {};
  // { path: { before, after } }
  const changed = {};

  console.log(result);
  for (const key of Object.keys(previousResult)) {
    if (!(key in result)) {
      console.log(key, result[key]);
      deleted[key] = previousResult[key];
    } else {
      if (previousResult[key].gzipSize !== result[key].gzipSize) {
        changed[key] = { before: previousResult[key], after: result[key] };
      }

      // Remove the entry so only new entries are left.
      delete result[key];
    }
  }

  // The remaining items in result must be new.
  const created = { ...result };

  if (Object.keys(deleted).length) {
    console.log('Deleted');
    for (const key of Object.keys(deleted)) {
      console.log(`  ${key} - ${deleted[key].gzipSize}`);
    }
  }

  if (Object.keys(changed).length) {
    console.log('Changed');
    for (const key of Object.keys(changed)) {
      console.log(`  ${key} - ${changed[key].before.gzipSize} -> ${changed[key].before.gzipSize}`);
    }
  }

  if (Object.keys(created).length) {
    console.log('Created');
    for (const key of Object.keys(created)) {
      console.log(`  ${key} - ${created[key].gzipSize}`);
    }
  }
}

main();
