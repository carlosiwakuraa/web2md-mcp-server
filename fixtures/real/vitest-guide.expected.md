<a id="getting-started"></a>
# Getting Started

<a id="overview"></a>
## Overview

Vitest (pronounced as *"veetest"*) is a next generation testing framework powered by Vite.

You can learn more about the rationale behind the project in the [Why Vitest](https://vitest.dev/guide/why) section.

<a id="trying-vitest-online"></a>
## Trying Vitest Online

You can try Vitest online on [StackBlitz](https://vitest.new/). It runs Vitest directly in the browser, and it is almost identical to the local setup but doesn't require installing anything on your machine.

<a id="adding-vitest-to-your-project"></a>
## Adding Vitest to Your Project

[Learn how to install by Video](https://vueschool.io/lessons/how-to-install-vitest?friend=vueuse)

npmyarnpnpmbundeno

bash

```bash
npm install -D vitest
```

bash

```bash
yarn add -D vitest vite
```

bash

```bash
pnpm add -D vitest
```

bash

```bash
bun add -D vitest
```

bash

```bash
deno add -D vitest
```

> [!TIP]
> Vitest requires Vite >=v6.4.0 and Node >=v22.12.0

It is recommended that you install a copy of `vitest` in your `package.json`, using one of the methods listed above. However, if you would prefer to run `vitest` directly, you can use `npx vitest` (the `npx` tool comes with npm and Node.js).

The `npx` tool will execute the specified command. By default, `npx` will first check if the command exists in the local project's binaries. If it is not found there, `npx` will look in the system's `$PATH` and execute it if found. If the command is not found in either location, `npx` will install it in a temporary location prior to execution.

Vitest and third party integrations can use `.vitest` directory to store generated artifacts. It's recommended to add this in your `.gitignore`.

.gitignore

sh

```sh
# Vitest reports and artifacts
.vitest/
```

<a id="writing-tests"></a>
## Writing Tests

As an example, we will write a simple test that verifies the output of a function that adds two numbers.

sum.js

js

```js
export function sum(a, b) {
  return a + b
}
```

sum.test.js

js

```js
import { expect, test } from 'vitest'
import { sum } from './sum.js'

test('adds 1 + 2 to equal 3', () => {
  expect(sum(1, 2)).toBe(3)
})
```

> [!TIP]
> By default, tests must contain `.test.` or `.spec.` in their file name.

Next, in order to execute the test, add the following section to your `package.json`:

package.json

json

```json
{
  "scripts": {
    "test": "vitest"
  }
}
```

Finally, run `npm run test`, `yarn test` or `pnpm test`, depending on your package manager, and Vitest will print this message:

txt

```txt
✓ sum.test.js (1)
  ✓ adds 1 + 2 to equal 3

Test Files  1 passed (1)
     Tests  1 passed (1)
  Start at  02:15:44
  Duration  311ms
```

> [!WARNING]
> If you are using Bun as your package manager, make sure to use `bun run test` command instead of `bun test`, otherwise Bun will run its own test runner.

Your first test is passing! Continue to [Writing Tests](https://vitest.dev/guide/learn/writing-tests) to learn about organizing tests, reading test output, and the core testing patterns you'll use every day.

To run tests once without watching for file changes, use `vitest run`. You can also pass additional flags like `--reporter` or `--coverage`. For a full list of CLI options, run `npx vitest --help` or see the [CLI guide](https://vitest.dev/guide/cli).

<a id="configuring-vitest"></a>
## Configuring Vitest

Vitest reads your `vite.config.*` by default, so your existing Vite plugins and configuration work out-of-the-box. You can also create a dedicated `vitest.config.*` for test-specific settings. See the [Config Reference](https://vitest.dev/config/) for details.

<a id="ide-integrations"></a>
## IDE Integrations

We also provided an official extension for Visual Studio Code to enhance your testing experience with Vitest.

[Install from VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=vitest.explorer)

Learn more about [IDE Integrations](https://vitest.dev/guide/ide)

<a id="examples"></a>
## Examples

| Example | Source | Playground |
| --- | --- | --- |
| `basic` | [GitHub](https://github.com/vitest-dev/vitest/tree/main/examples/basic) | [Play Online](https://stackblitz.com/fork/github/vitest-dev/vitest/tree/main/examples/basic?initialPath=__vitest__/) |
| `fastify` | [GitHub](https://github.com/vitest-dev/vitest/tree/main/examples/fastify) | [Play Online](https://stackblitz.com/fork/github/vitest-dev/vitest/tree/main/examples/fastify?initialPath=__vitest__/) |
| `in-source-test` | [GitHub](https://github.com/vitest-dev/vitest/tree/main/examples/in-source-test) | [Play Online](https://stackblitz.com/fork/github/vitest-dev/vitest/tree/main/examples/in-source-test?initialPath=__vitest__/) |
| `lit` | [GitHub](https://github.com/vitest-dev/vitest/tree/main/examples/lit) | [Play Online](https://stackblitz.com/fork/github/vitest-dev/vitest/tree/main/examples/lit?initialPath=__vitest__/) |
| `vue` | [GitHub](https://github.com/vitest-tests/browser-examples/tree/main/examples/vue) | [Play Online](https://stackblitz.com/fork/github/vitest-tests/browser-examples/tree/main/examples/vue?initialPath=__vitest__/) |
| `marko` | [GitHub](https://github.com/vitest-tests/browser-examples/tree/main/examples/marko) | [Play Online](https://stackblitz.com/fork/github/vitest-tests/browser-examples/tree/main/examples/marko?initialPath=__vitest__/) |
| `preact` | [GitHub](https://github.com/vitest-tests/browser-examples/tree/main/examples/preact) | [Play Online](https://stackblitz.com/fork/github/vitest-tests/browser-examples/tree/main/examples/preact?initialPath=__vitest__/) |
| `qwik` | [GitHub](https://github.com/vitest-tests/browser-examples/tree/main/examples/qwik) | [Play Online](https://stackblitz.com/fork/github/vitest-tests/browser-examples/tree/main/examples/qwik?initialPath=__vitest__/) |
| `react` | [GitHub](https://github.com/vitest-tests/browser-examples/tree/main/examples/react) | [Play Online](https://stackblitz.com/fork/github/vitest-tests/browser-examples/tree/main/examples/react?initialPath=__vitest__/) |
| `solid` | [GitHub](https://github.com/vitest-tests/browser-examples/tree/main/examples/solid) | [Play Online](https://stackblitz.com/fork/github/vitest-tests/browser-examples/tree/main/examples/solid?initialPath=__vitest__/) |
| `svelte` | [GitHub](https://github.com/vitest-tests/browser-examples/tree/main/examples/svelte) | [Play Online](https://stackblitz.com/fork/github/vitest-tests/browser-examples/tree/main/examples/svelte?initialPath=__vitest__/) |
| `profiling` | [GitHub](https://github.com/vitest-dev/vitest/tree/main/examples/profiling) | Not Available |
| `typecheck` | [GitHub](https://github.com/vitest-dev/vitest/tree/main/examples/typecheck) | [Play Online](https://stackblitz.com/fork/github/vitest-dev/vitest/tree/main/examples/typecheck?initialPath=__vitest__/) |
| `projects` | [GitHub](https://github.com/vitest-dev/vitest/tree/main/examples/projects) | [Play Online](https://stackblitz.com/fork/github/vitest-dev/vitest/tree/main/examples/projects?initialPath=__vitest__/) |

<a id="community"></a>
## Community

If you have questions or need help, reach out to the community at [Discord](https://chat.vitest.dev/) and [GitHub Discussions](https://github.com/vitest-dev/vitest/discussions).
