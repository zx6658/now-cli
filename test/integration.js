import path from 'path';
import { URL } from 'url';
import test from 'ava';
import semVer from 'semver';
import fs from 'fs';
import { homedir } from 'os';
import execa from 'execa';
import fetch from 'node-fetch';
import tmp from 'tmp-promise';
import logo from '../src/util/output/logo';
import sleep from '../src/util/sleep';
import pkg from '../package';
import parseList from './helpers/parse-list';
import prepareFixtures from './helpers/prepare';

const binary = {
  darwin: 'now-macos',
  linux: 'now-linux',
  win32: 'now-win.exe'
}[process.platform];

const binaryPath = path.resolve(__dirname, `../packed/${binary}`);
const fixture = name => path.join(__dirname, 'fixtures', 'integration', name);
const deployHelpMessage = `${logo} now [options] <command | path>`;
const session = Math.random()
  .toString(36)
  .split('.')[1];

const pickUrl = stdout => {
  const lines = stdout.split('\n');
  return lines[lines.length - 1];
};

const waitForDeployment = async href => {
  // eslint-disable-next-line
  while (true) {
    const response = await fetch(href, { redirect: 'manual' });
    if (response.status === 200) {
      break;
    }

    await sleep(2000);
  }
};

function fetchTokenWithRetry (url, retries = 3) {
  return new Promise(async (resolve, reject) => {
    try {
      const res = await fetch(url);
      const data = await res.json();
      resolve(data.token);
    } catch (error) {
      console.log(`Failed to fetch token. Retries remaining: ${retries}`);
      if (retries === 0) {
        reject(error);
        return;
      }
      setTimeout(() => {
        fetchTokenWithRetry(url, retries - 1)
          .then(resolve)
          .catch(reject);
      }, 500);
    }
  });
}

function fetchTokenInformation (token, retries = 3) {
  return new Promise(async (resolve, reject) => {
    const url = `https://api.zeit.co/www/user`
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      const data = await res.json();
      resolve(data.user);
    } catch (error) {
      console.log(`Failed to fetch token. Retries remaining: ${retries}`);
      if (retries === 0) {
        reject(error);
        return;
      }
      setTimeout(() => {
        fetchTokenWithRetry(url, retries - 1)
          .then(resolve)
          .catch(reject);
      }, 500);
    }
  });
}

// AVA's `t.context` can only be set before the tests,
// but we want to set it within as well
const context = {};

const defaultOptions = { reject: false };
const defaultArgs = [];
let email
let contextName

let tmpDir;

if (!process.env.CI) {
  tmpDir = tmp.dirSync({
    // This ensures the directory gets
    // deleted even if it has contents
    unsafeCleanup: true
  });

  defaultArgs.push('-Q', path.join(tmpDir.name, '.now'));
}

test.before(async () => {
  try {
    const location = path.join(tmpDir ? tmpDir.name : homedir(), '.now');
    const str = 'aHR0cHM6Ly9hcGktdG9rZW4tZmFjdG9yeS56ZWl0LnNo';
    const token = await fetchTokenWithRetry(
      Buffer.from(str, 'base64').toString()
    );

    if (!fs.existsSync(location)) {
      await createDirectory(location)
    }
    await fs.promises.writeFile(path.join(location, `auth.json`), JSON.stringify({ token }))

    const user = await fetchTokenInformation(token)

    email = user.email
    contextName = `${user.email.split('@')[0]}`

    prepareFixtures(contextName);
  } catch (err) {
    console.error(err);
  }
});

const execute = (args, options) =>
  execa(binaryPath, [...defaultArgs, ...args], {
    ...defaultOptions,
    ...options
  });

test('print the deploy help message', async t => {
  const { stderr, code } = await execa(binaryPath, ['help', ...defaultArgs], {
    reject: false
  });

  t.is(code, 2);
  t.true(stderr.includes(deployHelpMessage));
});

test('output the version', async t => {
  const { stdout, code } = await execa(
    binaryPath,
    ['--version', ...defaultArgs],
    {
      reject: false
    }
  );

  const version = stdout.trim();

  t.is(code, 0);
  t.truthy(semVer.valid(version));
  t.is(version, pkg.version);
});

test('log in', async t => {
  const { stdout, code } = await execa(
    binaryPath,
    ['login', `${session}@${session}.com`, ...defaultArgs],
    {
      reject: false
    }
  );

  const goal = `> Error! Please sign up: https://zeit.co/signup`;
  const lines = stdout.trim().split('\n');
  const last = lines[lines.length - 1];

  t.is(code, 1);
  t.is(last, goal);
});

test('deploy a node microservice', async t => {
  const target = fixture('node');

  const { stdout, stderr, code } = await execa(
    binaryPath,
    [target, '--public', '--name', session, ...defaultArgs],
    {
      reject: false
    }
  );

  console.log(stderr);

  // Ensure the exit code is right
  t.is(code, 0);

  // Test if the output is really a URL
  const { href, host } = new URL(stdout);
  t.is(host.split('-')[0], session);

  // Send a test request to the deployment
  const response = await fetch(href);
  const contentType = response.headers.get('content-type');
  const content = await response.json();

  t.is(contentType, 'application/json; charset=utf-8');
  t.is(content.id, contextName);
});

test('deploy a node microservice and infer name from `package.json`', async t => {
  const target = fixture('node');

  const { stdout, code } = await execa(
    binaryPath,
    [target, '--public', ...defaultArgs],
    {
      reject: false
    }
  );

  // Ensure the exit code is right
  t.is(code, 0);

  // Test if the output is really a URL
  const { host } = new URL(stdout);
  t.true(host.startsWith(`node-test-${contextName}`));
});

test('find deployment in list', async t => {
  const { stdout, code } = await execa(binaryPath, ['ls', ...defaultArgs], {
    reject: false
  });

  const deployments = parseList(stdout);

  t.true(deployments.length > 0);
  t.is(code, 0);

  const target = deployments.find(deployment =>
    deployment.includes(`${session}-`)
  );

  t.truthy(target);

  if (target) {
    context.deployment = target;
  }
});

test('find deployment in list with mixed args', async t => {
  const { stdout, code } = await execa(
    binaryPath,
    ['--debug', 'ls', ...defaultArgs],
    {
      reject: false
    }
  );

  const deployments = parseList(stdout);

  t.true(deployments.length > 0);
  t.is(code, 0);

  const target = deployments.find(deployment =>
    deployment.includes(`${session}-`)
  );

  t.truthy(target);

  if (target) {
    context.deployment = target;
  }
});

test('create alias for deployment', async t => {
  const hosts = {
    deployment: context.deployment,
    alias: `${session}.now.sh`
  };

  const { stdout, code } = await execa(
    binaryPath,
    ['alias', hosts.deployment, hosts.alias, ...defaultArgs],
    {
      reject: false
    }
  );

  const goal = `> Success! https://${hosts.alias} now points to https://${hosts.deployment}`;

  t.is(code, 0);
  t.true(stdout.startsWith(goal));

  // Send a test request to the alias
  const response = await fetch(`https://${hosts.alias}`);
  const contentType = response.headers.get('content-type');
  const content = await response.json();

  t.is(contentType, 'application/json; charset=utf-8');
  t.is(content.id, contextName);

  context.alias = hosts.alias;
});

test('list the aliases', async t => {
  const { stdout, code } = await execa(
    binaryPath,
    ['alias', 'ls', ...defaultArgs],
    {
      reject: false
    }
  );

  const results = parseList(stdout);

  t.is(code, 0);
  t.true(results.includes(context.deployment));
});

test('scale the alias', async t => {
  const { stdout, code } = await execa(
    binaryPath,
    ['scale', context.alias, 'bru', '1', ...defaultArgs],
    {
      reject: false
    }
  );

  t.is(code, 0);
  t.true(stdout.includes(`(min: 1, max: 1)`));
});

test('remove the alias', async t => {
  const goal = `> Success! Alias ${context.alias} removed`;

  const { stdout, code } = await execa(
    binaryPath,
    ['alias', 'rm', context.alias, '--yes', ...defaultArgs],
    {
      reject: false
    }
  );

  t.is(code, 0);
  t.true(stdout.startsWith(goal));
});

test('scale down the deployment directly', async t => {
  const { stdout, code } = await execa(
    binaryPath,
    ['scale', context.deployment, 'bru', '0', ...defaultArgs],
    {
      reject: false
    }
  );

  t.is(code, 0);
  t.true(stdout.includes(`(min: 0, max: 0)`));
});

test('list the scopes', async t => {
  const { stdout, code } = await execa(
    binaryPath,
    ['teams', 'ls', ...defaultArgs],
    {
      reject: false
    }
  );

  t.is(code, 0);
  t.true(stdout.includes(`✔ ${contextName}     ${email}`));
});

test('list the payment methods', async t => {
  const { stdout, code } = await execa(
    binaryPath,
    ['billing', 'ls', ...defaultArgs],
    {
      reject: false
    }
  );

  t.is(code, 0);
  t.true(stdout.startsWith(`> 0 cards found under ${contextName}`));
});

test('try to purchase a domain', async t => {
  const { stderr, code } = await execa(
    binaryPath,
    ['domains', 'buy', `${session}-test.org`, ...defaultArgs],
    {
      reject: false,
      input: 'y'
    }
  );

  t.is(code, 1);
  t.true(
    stderr.includes(
      `> Error! Could not purchase domain. Please add a payment method using \`now billing add\`.`
    )
  );
});

test('try to transfer-in a domain with "--code" option', async t => {
  const { stderr, code } = await execa(
    binaryPath,
    [
      'domains',
      'transfer-in',
      '--code',
      'xyz',
      `${session}-test.org`,
      ...defaultArgs
    ],
    {
      reject: false
    }
  );

  t.true(
    stderr.includes(
      `> Error! The domain "${session}-test.org" is not transferable.`
    )
  );
  t.is(code, 1);
});

test('try to move an invalid domain', async t => {
  const { stderr, code } = await execa(
    binaryPath,
    [
      'domains',
      'move',
      `${session}-invalid-test.org`,
      `${session}-invalid-user`,
      ...defaultArgs
    ],
    {
      reject: false
    }
  );

  t.true(stderr.includes(`> Error! Domain not found under `));
  t.is(code, 1);
});

test('try to set default without existing payment method', async t => {
  const { stderr, code } = await execa(
    binaryPath,
    ['billing', 'set-default', ...defaultArgs],
    {
      reject: false
    }
  );

  t.is(code, 0);
  t.true(stderr.includes('You have no credit cards to choose from'));
});

test('try to remove a non-existing payment method', async t => {
  const { stderr, code } = await execa(
    binaryPath,
    ['billing', 'rm', 'card_d2j32d9382jr928rd', ...defaultArgs],
    {
      reject: false
    }
  );

  t.is(code, 0);
  t.true(
    stderr.includes(
      `You have no credit cards to choose from to delete under ${contextName}`
    )
  );
});

test('use `-V 1` to deploy a GitHub repository', async t => {
  const { stdout, code } = await execa(
    binaryPath,
    ['-V', 1, '--public', '--name', session, ...defaultArgs, 'leo/hub'],
    {
      reject: false
    }
  );

  // Ensure the exit code is right
  t.is(code, 0);

  // Test if the output is really a URL
  const { href, host } = new URL(stdout);
  t.is(host.split('-')[0], session);

  // Send a test request to the deployment
  const response = await fetch(href, {
    headers: {
      Accept: 'application/json'
    }
  });

  const contentType = response.headers.get('content-type');
  t.is(contentType, 'application/json; charset=utf-8');
});

test('use `--platform-version 1` to deploy a GitHub repository', async t => {
  const { stdout, code } = await execa(
    binaryPath,
    [
      '--platform-version',
      1,
      '--public',
      '--name',
      session,
      ...defaultArgs,
      'leo/hub'
    ],
    {
      reject: false
    }
  );

  // Ensure the exit code is right
  t.is(code, 0);

  // Test if the output is really a URL
  const { href, host } = new URL(stdout);
  t.is(host.split('-')[0], session);

  // Send a test request to the deployment
  const response = await fetch(href, {
    headers: {
      Accept: 'application/json'
    }
  });

  const contentType = response.headers.get('content-type');
  t.is(contentType, 'application/json; charset=utf-8');
});

test('set platform version using `-V` to `1`', async t => {
  const directory = fixture('builds');
  const goal =
    '> Error! The property `builds` is only allowed on Now 2.0 — please upgrade';

  const { stderr, code } = await execa(
    binaryPath,
    [directory, '--public', '--name', session, ...defaultArgs, '-V', 1],
    {
      reject: false
    }
  );

  // Ensure the exit code is right
  t.is(code, 1);

  // Ensure the error message shows up
  t.true(stderr.includes(goal));
});

test('set platform version using `--platform-version` to `1`', async t => {
  const directory = fixture('builds');
  const goal =
    '> Error! The property `builds` is only allowed on Now 2.0 — please upgrade';

  const { stderr, code } = await execa(
    binaryPath,
    [
      directory,
      '--public',
      '--name',
      session,
      ...defaultArgs,
      '--platform-version',
      1
    ],
    {
      reject: false
    }
  );

  // Ensure the exit code is right
  t.is(code, 1);

  // Ensure the error message shows up
  t.true(stderr.includes(goal));
});

test('set platform version using `-V` to invalid number', async t => {
  const directory = fixture('builds');
  const goal =
    '> Error! The "--platform-version" option must be either `1` or `2`.';

  const { stderr, code } = await execa(
    binaryPath,
    [directory, '--public', '--name', session, ...defaultArgs, '-V', 3],
    {
      reject: false
    }
  );

  // Ensure the exit code is right
  t.is(code, 1);

  // Ensure the error message shows up
  t.true(stderr.includes(goal));
});

test('set platform version using `--platform-version` to invalid number', async t => {
  const directory = fixture('builds');
  const goal =
    '> Error! The "--platform-version" option must be either `1` or `2`.';

  const { stderr, code } = await execa(
    binaryPath,
    [
      directory,
      '--public',
      '--name',
      session,
      ...defaultArgs,
      '--platform-version',
      3
    ],
    {
      reject: false
    }
  );

  // Ensure the exit code is right
  t.is(code, 1);

  // Ensure the error message shows up
  t.true(stderr.includes(goal));
});

test('set platform version using `-V` to `2`', async t => {
  const directory = fixture('builds');

  const { stdout, stderr, code } = await execa(
    binaryPath,
    [
      directory,
      '--public',
      '--name',
      session,
      ...defaultArgs,
      '-V',
      2,
      '--force'
    ],
    {
      reject: false
    }
  );

  // Ensure the exit code is right
  t.is(code, 0);

  // Ensure the listing includes the necessary parts
  const wanted = [session, 'index.html'];

  t.true(stderr.includes('Building...'));

  // Test if the output is really a URL
  const { href, host } = new URL(stdout);
  t.is(host.split('-')[0], session);

  if (host) {
    context.deployment = host;
  }

  // Send a test request to the deployment
  const response = await fetch(href);
  const contentType = response.headers.get('content-type');

  t.is(contentType, 'text/html; charset=utf-8');
});

test('output logs of a 2.0 deployment', async t => {
  const { stderr, code } = await execa(
    binaryPath,
    ['logs', context.deployment, ...defaultArgs],
    {
      reject: false
    }
  );

  t.true(stderr.includes(`Fetched deployment "${context.deployment}"`));
  t.is(code, 0);
});

test('ensure type and instance count in list is right', async t => {
  const { stdout, code } = await execa(binaryPath, ['ls', ...defaultArgs], {
    reject: false
  });

  // Ensure the exit code is right
  t.is(code, 0);

  const line = stdout.split('\n').find(line => line.includes('.now.sh'));
  const columns = line.split(/\s+/);

  // Ensure those columns only contain a dash
  t.is(columns[3], '-');
  t.is(columns[4], '-');
});

test('set platform version using `--platform-version` to `2`', async t => {
  const directory = fixture('builds');

  const { stdout, stderr, code } = await execa(
    binaryPath,
    [
      directory,
      '--public',
      '--name',
      session,
      ...defaultArgs,
      '--platform-version',
      2,
      '--force'
    ],
    {
      reject: false
    }
  );

  // Ensure the exit code is right
  t.is(code, 0);

  // Ensure the listing includes the necessary parts
  const wanted = [session, 'index.html'];

  t.true(stderr.includes('Building...'));

  // Test if the output is really a URL
  const { href, host } = new URL(stdout);
  t.is(host.split('-')[0], session);

  // Send a test request to the deployment
  const response = await fetch(href);
  const contentType = response.headers.get('content-type');

  t.is(contentType, 'text/html; charset=utf-8');
});

test('ensure we render a warning for deployments with no files', async t => {
  const directory = fixture('single-dotfile');

  const { stderr, stdout, code } = await execa(
    binaryPath,
    [directory, '--public', '--name', session, ...defaultArgs, '--force'],
    {
      reject: false
    }
  );

  // Ensure the warning is printed
  t.true(stderr.includes('> WARN! There are no files (or only files starting with a dot) inside your deployment.'));

  // Test if the output is really a URL
  const { href, host } = new URL(stdout);
  t.is(host.split('-')[0], session);

  // Ensure the exit code is right
  t.is(code, 0);

  // Send a test request to the deployment
  const response = await fetch(href);
  const contentType = response.headers.get('content-type');

  t.is(contentType, 'text/plain; charset=utf-8');
});

test('ensure the `alias` property is not sent to the API', async t => {
  const directory = fixture('config-alias-property');

  const { stderr, stdout, code } = await execa(
    binaryPath,
    [directory, '--public', '--name', session, ...defaultArgs, '--force'],
    {
      reject: false
    }
  );

  // Ensure the exit code is right
  t.is(code, 0);

  // Ensure the listing includes the necessary parts
  const wanted = [session, 'index.html'];

  t.true(stderr.includes('Building...'));

  // Test if the output is really a URL
  const { href, host } = new URL(stdout);
  t.is(host.split('-')[0], session);

  // Send a test request to the deployment
  const response = await fetch(href);
  const contentType = response.headers.get('content-type');

  t.is(contentType, 'text/html; charset=utf-8');
});

test('ensure the `scope` property works with email', async t => {
  const directory = fixture('config-scope-property-email');

  const { stderr, stdout, code } = await execa(
    binaryPath,
    [directory, '--public', '--name', session, ...defaultArgs, '--force'],
    {
      reject: false
    }
  );

  // Ensure we're deploying under the right scope
  t.true(stderr.includes(session));

  // Ensure the exit code is right
  t.is(code, 0);

  // Ensure the listing includes the necessary parts
  const wanted = [session, 'index.html'];

  t.true(stderr.includes('Building...'));

  // Test if the output is really a URL
  const { href, host } = new URL(stdout);
  t.is(host.split('-')[0], session);

  // Send a test request to the deployment
  const response = await fetch(href);
  const contentType = response.headers.get('content-type');

  t.is(contentType, 'text/html; charset=utf-8');
});

test('ensure the `scope` property works with username', async t => {
  const directory = fixture('config-scope-property-username');

  const { stderr, stdout, code } = await execa(
    binaryPath,
    [directory, '--public', '--name', session, ...defaultArgs, '--force'],
    {
      reject: false
    }
  );

  // Ensure we're deploying under the right scope
  t.true(stderr.includes(contextName));

  // Ensure the exit code is right
  t.is(code, 0);

  // Ensure the listing includes the necessary parts
  const wanted = [session, 'index.html'];

  t.true(stderr.includes('Building...'));

  // Test if the output is really a URL
  const { href, host } = new URL(stdout);
  t.is(host.split('-')[0], session);

  // Send a test request to the deployment
  const response = await fetch(href);
  const contentType = response.headers.get('content-type');

  t.is(contentType, 'text/html; charset=utf-8');
});

test('try to create a builds deployments with wrong config', async t => {
  const directory = fixture('builds-wrong');

  const { stderr, code } = await execa(
    binaryPath,
    [directory, '--public', '--name', session, ...defaultArgs, '--force'],
    {
      reject: false
    }
  );

  // Ensure the exit code is right
  t.is(code, 1);
  t.true(
    stderr.includes(
      '> Error! The property `builder` is not allowed in now.json when using Now 2.0 – please remove it.'
    )
  );
});

test('create a builds deployments with no actual builds', async t => {
  const directory = fixture('builds-no-list');

  const { stdout, code } = await execa(
    binaryPath,
    [directory, '--public', '--name', session, ...defaultArgs, '--force'],
    {
      reject: false
    }
  );

  // Ensure the exit code is right
  t.is(code, 0);

  // Test if the output is really a URL
  const { host } = new URL(stdout);
  t.is(host.split('-')[0], session);
});

test('create a builds deployments without platform version flag', async t => {
  const directory = fixture('builds');

  const { stdout, stderr, code } = await execa(
    binaryPath,
    [directory, '--public', '--name', session, ...defaultArgs, '--force'],
    {
      reject: false
    }
  );

  // Ensure the exit code is right
  t.is(code, 0);

  // Ensure the listing includes the necessary parts
  const wanted = [session, 'index.html'];

  t.true(stderr.includes('Building...'));

  // Test if the output is really a URL
  const { href, host } = new URL(stdout);
  t.is(host.split('-')[0], session);

  // Send a test request to the deployment
  const response = await fetch(href);
  const contentType = response.headers.get('content-type');

  t.is(contentType, 'text/html; charset=utf-8');
});

test('deploy multiple static files', async t => {
  const directory = fixture('static-multiple-files');

  const { stdout, code } = await execa(
    binaryPath,
    [directory, '--public', '--name', session, ...defaultArgs],
    {
      reject: false
    }
  );

  // Ensure the exit code is right
  t.is(code, 0);

  // Test if the output is really a URL
  const { href, host } = new URL(stdout);
  t.is(host.split('-')[0], session);

  // Send a test request to the deployment
  const response = await fetch(href, {
    headers: {
      Accept: 'application/json'
    }
  });

  const contentType = response.headers.get('content-type');
  t.is(contentType, 'application/json; charset=utf-8');

  const content = await response.json();
  t.is(content.files.length, 3);
});

test('ensure we are getting a warning for the old team flag', async t => {
  const directory = fixture('static-multiple-files');

  const { stderr, stdout, code } = await execa(
    binaryPath,
    [directory, '--public', '--name', session, '--team', email, ...defaultArgs],
    {
      reject: false
    }
  );

  // Ensure the warning is printed
  t.true(stderr.includes('WARN! The "--team" flag is deprecated. Please use "--scope" instead.'));

  // Ensure the exit code is right
  t.is(code, 0);

  // Test if the output is really a URL
  const { href, host } = new URL(stdout);
  t.is(host.split('-')[0], session);

  // Send a test request to the deployment
  const response = await fetch(href, {
    headers: {
      Accept: 'application/json'
    }
  });

  const contentType = response.headers.get('content-type');
  t.is(contentType, 'application/json; charset=utf-8');

  const content = await response.json();
  t.is(content.files.length, 3);
});

test('deploy multiple static files with custom scope', async t => {
  const directory = fixture('static-multiple-files');

  const { stdout, code } = await execa(
    binaryPath,
    [directory, '--public', '--name', session, '--scope', email, ...defaultArgs],
    {
      reject: false
    }
  );

  // Ensure the exit code is right
  t.is(code, 0);

  // Test if the output is really a URL
  const { href, host } = new URL(stdout);
  t.is(host.split('-')[0], session);

  // Send a test request to the deployment
  const response = await fetch(href, {
    headers: {
      Accept: 'application/json'
    }
  });

  const contentType = response.headers.get('content-type');
  t.is(contentType, 'application/json; charset=utf-8');

  const content = await response.json();
  t.is(content.files.length, 3);
});

test('deploy single static file', async t => {
  const file = fixture('static-single-file/first.png');

  const { stdout, code } = await execa(
    binaryPath,
    [file, '--public', '--name', session, ...defaultArgs],
    {
      reject: false
    }
  );

  // Ensure the exit code is right
  t.is(code, 0);

  // Test if the output is really a URL
  const { href, host } = new URL(stdout);
  t.is(host.split('-')[0], session);

  // Send a test request to the deployment
  const response = await fetch(href);
  const contentType = response.headers.get('content-type');

  t.is(contentType, 'image/png');
  t.deepEqual(await fs.promises.readFile(file), await response.buffer());
});

test('deploy a static directory', async t => {
  const directory = fixture('static-single-file');

  const { stdout, code } = await execa(
    binaryPath,
    [directory, '--public', '--name', session, ...defaultArgs],
    {
      reject: false
    }
  );

  // Ensure the exit code is right
  t.is(code, 0);

  // Test if the output is really a URL
  const { href, host } = new URL(stdout);
  t.is(host.split('-')[0], session);

  // Send a test request to the deployment
  const response = await fetch(href);
  const contentType = response.headers.get('content-type');

  t.is(contentType, 'text/html; charset=utf-8');
});

test('deploy a static build deployment', async t => {
  const directory = fixture('now-static-build');

  const { stdout, code } = await execa(
    binaryPath,
    [directory, '--public', '--name', session, ...defaultArgs],
    {
      reject: false
    }
  );

  // Ensure the exit code is right
  t.is(code, 0);

  // Test if the output is really a URL
  const deploymentUrl = pickUrl(stdout);
  const { href, host } = new URL(deploymentUrl);
  t.is(host.split('-')[0], session);

  await waitForDeployment(href);

  // get the content
  const response = await fetch(href);
  const content = await response.text();
  t.is(content.trim(), 'hello');
});

test('use build-env', async t => {
  const directory = fixture('build-env');

  const { stdout, code } = await execa(
    binaryPath,
    [directory, '--public', '--name', session, ...defaultArgs],
    {
      reject: false
    }
  );

  // Ensure the exit code is right
  t.is(code, 0);

  // Test if the output is really a URL
  const deploymentUrl = pickUrl(stdout);
  const { href, host } = new URL(deploymentUrl);
  t.is(host.split('-')[0], session);

  await waitForDeployment(href);

  // get the content
  const response = await fetch(href);
  const content = await response.text();
  t.is(content.trim(), 'bar');
});

test('deploy a dockerfile project', async t => {
  const target = fixture('dockerfile');

  const { stdout, code } = await execa(
    binaryPath,
    [
      target,
      '--public',
      '--name',
      session,
      '--docker',
      '--no-verify',
      ...defaultArgs
    ],
    {
      reject: false
    }
  );

  // Ensure the exit code is right
  t.is(code, 0);

  // Test if the output is really a URL
  const { href, host } = new URL(stdout);
  t.is(host.split('-')[0], session);

  // Send a test request to the deployment
  const response = await fetch(href);
  const contentType = response.headers.get('content-type');
  const textContent = await response.text();
  let content;

  try {
    content = JSON.parse(textContent);
  } catch (error) {
    console.log('Error parsing response as JSON:');
    console.error(textContent);
    throw error;
  }

  t.is(contentType, 'application/json; charset=utf-8');
  t.is(content.id, contextName);
});

test('use `--build-env` CLI flag', async t => {
  const directory = fixture('build-env-arg');
  const nonce = Math.random()
    .toString(36)
    .substring(2);

  const { stdout, code } = await execa(
    binaryPath,
    [
      directory,
      '--public',
      '--name',
      session,
      '--build-env',
      `NONCE=${nonce}`,
      ...defaultArgs
    ],
    {
      reject: false
    }
  );

  // Ensure the exit code is right
  t.is(code, 0);

  // Test if the output is really a URL
  const deploymentUrl = pickUrl(stdout);
  const { href, host } = new URL(deploymentUrl);
  t.is(host.split('-')[0], session);

  await waitForDeployment(href);

  // get the content
  const response = await fetch(href);
  const content = await response.text();
  t.is(content.trim(), nonce);
});

test('try to deploy non-existing path', async t => {
  const goal = `> Error! The specified file or directory "${session}" does not exist.`;

  const { stderr, code } = await execa(binaryPath, [session, ...defaultArgs], {
    reject: false
  });

  t.is(code, 1);
  t.true(stderr.trim().endsWith(goal));
});

test('try to deploy with non-existing team', async t => {
  const target = fixture('node');
  const goal = `> Error! The specified scope does not exist`;

  const { stderr, code } = await execa(
    binaryPath,
    [target, '--scope', session, ...defaultArgs],
    {
      reject: false
    }
  );

  t.is(code, 1);
  t.true(stderr.includes(goal));
});

const createFile = dest => fs.closeSync(fs.openSync(dest, 'w'));
const createDirectory = dest => fs.mkdirSync(dest);
const verifyExampleApollo = (cwd, dir) =>
  fs.existsSync(path.join(cwd, dir, 'package.json')) &&
  fs.existsSync(path.join(cwd, dir, 'now.json')) &&
  fs.existsSync(path.join(cwd, dir, 'index.js'));
const verifyExampleAmp = (cwd, dir) =>
  fs.existsSync(path.join(cwd, dir, 'favicon.png')) &&
  fs.existsSync(path.join(cwd, dir, 'index.html')) &&
  fs.existsSync(path.join(cwd, dir, 'logo.png')) &&
  fs.existsSync(path.join(cwd, dir, 'now.json'));

test('initialize example "apollo"', async t => {
  tmpDir = tmp.dirSync({ unsafeCleanup: true });
  const cwd = tmpDir.name;
  const goal = '> Success! Initialized "apollo" example in';

  const { stdout, code } = await execute(['init', 'apollo'], { cwd });

  t.is(code, 0);
  t.true(stdout.includes(goal));
  t.true(verifyExampleApollo(cwd, 'apollo'));
});

test('initialize example ("apollo") to specified directory', async t => {
  tmpDir = tmp.dirSync({ unsafeCleanup: true });
  const cwd = tmpDir.name;
  const goal = '> Success! Initialized "apollo" example in';

  const { stdout, code } = await execute(['init', 'apollo', 'apo'], { cwd });

  t.is(code, 0);
  t.true(stdout.includes(goal));
  t.true(verifyExampleApollo(cwd, 'apo'));
});

test('initialize selected example ("amp")', async t => {
  tmpDir = tmp.dirSync({ unsafeCleanup: true });
  const cwd = tmpDir.name;
  const goal = '> Success! Initialized "amp" example in';

  const { stdout, code } = await execute(['init'], { cwd, input: '\n' });

  t.is(code, 0);
  t.true(stdout.includes(goal));
  t.true(verifyExampleAmp(cwd, 'amp'));
});

test('initialize example to existing directory with "-f"', async t => {
  tmpDir = tmp.dirSync({ unsafeCleanup: true });
  const cwd = tmpDir.name;
  const goal = '> Success! Initialized "apollo" example in';

  createDirectory(path.join(cwd, 'apollo'));
  createFile(path.join(cwd, 'apollo', '.gitignore'));
  const { stdout, code } = await execute(['init', 'apollo', '-f'], { cwd });

  t.is(code, 0);
  t.true(stdout.includes(goal));
  t.true(verifyExampleApollo(cwd, 'apollo'));
});

test('try to initialize example to existing directory', async t => {
  tmpDir = tmp.dirSync({ unsafeCleanup: true });
  const cwd = tmpDir.name;
  const goal =
    '> Error! Destination path "apollo" already exists and is not an empty directory. You may use `--force` or `--f` to override it.';

  createDirectory(path.join(cwd, 'apollo'));
  createFile(path.join(cwd, 'apollo', '.gitignore'));
  const { stdout, code } = await execute(['init', 'apollo'], {
    cwd,
    input: '\n'
  });

  t.is(code, 1);
  t.true(stdout.includes(goal));
});

test('try to initialize misspelled example (noce) in non-tty', async t => {
  tmpDir = tmp.dirSync({ unsafeCleanup: true });
  const cwd = tmpDir.name;
  const goal = '> Error! No example for noce.';

  const { stdout, code } = await execute(['init', 'noce'], { cwd });

  t.is(code, 1);
  t.true(stdout.includes(goal));
});

test('try to initialize example "example-404"', async t => {
  tmpDir = tmp.dirSync({ unsafeCleanup: true });
  const cwd = tmpDir.name;
  const goal = 'No example for example-404';

  const { stdout, code } = await execute(['init', 'example-404'], { cwd });

  t.is(code, 1);
  t.true(stdout.includes(goal));
});

test('try to revert a deployment and assign the automatic aliases', async t => {
  const firstDeployment = fixture('now-revert-alias-1');
  const secondDeployment = fixture('now-revert-alias-2');

  const { name } = JSON.parse(fs.readFileSync(path.join(firstDeployment, 'now.json')));
  const url = `https://${name}.user.now.sh`;

  {
    const { stdout: deploymentUrl, code } = await execute([firstDeployment]);
    t.is(code, 0);

    await waitForDeployment(deploymentUrl);
    await sleep(20000);

    const result = await fetch(url).then(r => r.json());

    t.is(
      result.name,
      'now-revert-alias-1',
      `[First run] Received ${result.name} instead on ${url} (${deploymentUrl})`
    );
  }

  {
    const { stdout: deploymentUrl, code } = await execute([secondDeployment]);
    t.is(code, 0);

    await waitForDeployment(deploymentUrl);
    await sleep(20000);

    const result = await fetch(url).then(r => r.json());

    t.is(
      result.name,
      'now-revert-alias-2',
      `[Second run] Received ${result.name} instead on ${url} (${deploymentUrl})`
    );
  }

  {
    const { stdout: deploymentUrl, code } = await execute([firstDeployment]);
    t.is(code, 0);

    await waitForDeployment(deploymentUrl);
    await sleep(20000);

    const result = await fetch(url).then(r => r.json());

    t.is(
      result.name,
      'now-revert-alias-1',
      `[Third run] Received ${result.name} instead on ${url} (${deploymentUrl})`
    );
  }
});

test('whoami', async t => {
  const { code, stdout, stderr } = await execute(['whoami']);
  t.is(code, 0);
  t.is(stdout, contextName);
});

test('try to update now to canary', async t => {
  const { code } = await execute(['update', '--channel', 'canary', '--yes']);
  t.is(code, 0);

  const { stdout } = await execute(['--version']);
  t.true(stdout.includes('canary'));
});

test.after.always(async () => {
  // Make sure the token gets revoked
  await execa(binaryPath, ['logout', ...defaultArgs]);

  if (!tmpDir) {
    return;
  }

  // Remove config directory entirely
  tmpDir.removeCallback();
});
