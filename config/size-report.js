const path = require('path');
const fs = require('fs');
const util = require('util');
const https = require('https');

const gzipSize = require('gzip-size');

const readdir = util.promisify(fs.readdir);

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const { statusCode } = res;
      const contentType = res.headers['content-type'];

      let error;

      if (statusCode !== 200) {
        error = new Error(
          'Request Failed.\n' +
          `Status Code: ${statusCode}`
        );
      } else if (!/^application\/json/.test(contentType)) {
        error = new Error(
          'Invalid content-type.\n' +
          `Expected application/json but received ${contentType}`
        );
      }

      if (error) {
        // consume response data to free up memory
        res.resume();
        reject(error);
        return;
      }

      res.setEncoding('utf8');
      let rawData = '';
      res.on('data', (chunk) => { rawData += chunk; });
      res.on('end', () => {
        try {
          const parsedData = JSON.parse(rawData);
          resolve(parsedData);
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function dirToObj(startPath, {
  entryPrefix = '',
} = {}) {
  const entries = await readdir(startPath, { withFileTypes: true });
  const promises = [];
  const result = {};

  for (const entry of entries) {
    const entryPath = path.join(startPath, entry.name);
    if (entry.isFile()) {
      promises.push(async function() {
        result[entryPrefix + entry.name] = {
          gzipSize: await gzipSize.file(entryPath),
        };
      }());
    } else if (entry.isDirectory()) {
      promises.push(async function() {
        const dirResult = await dirToObj(entryPath, {
          entryPrefix: entry.name + '/',
        });

        Object.assign(result, dirResult);
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
  const result = await dirToObj(__dirname + '/../build');
  console.log(buildSizePrefix + JSON.stringify(result));

  // Get the previous results.
  //const branchData = await getJson('https://api.travis-ci.org/repos/GoogleChromeLabs/squoosh/branches/master');
  //const jobId = branchData.branch.job_ids[0];
  //const { log } = await getJson(`https://api.travis-ci.org/jobs/${jobId}`);
}

main();
