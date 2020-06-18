# delay-app <img align="right" src="https://github.com/1Hive/website/blob/master/website/static/img/bee.png" height="80px" />

[![CircleCI](https://circleci.com/gh/1Hive/delay-app.svg?style=svg)](https://circleci.com/gh/1Hive/delay-app)
[![Coverage Status](https://coveralls.io/repos/github/1Hive/delay-app/badge.svg?branch=master&service=github)](https://coveralls.io/github/1Hive/delay-app?branch=master&service=github)

The delay app enables Aragon organizations to require a configurable delay between when an intent is sent and when it is executed.

#### 🚨 Security Review Status: Not Audited
[Contract audited](https://diligence.consensys.net/audits/2019/12/dandelion-organizations/) at a 
[previous commit](https://github.com/1Hive/delay-app/tree/80db310f4e912a3813f4ef45208ffcd4c4198eaa)

## How does it work?

The Delay app keeps track of the time left until scripts can be executed, the script to execute, and the time that the script was paused at.

### Initialization

The Delay app is initialized with the `_executionDelay` parameter. This defines the default length that a user will have to wait to execute a delayed script, provided it is not paused at some point during the delay.

### Roles

The Delay app should implement the following roles:

- `SET_DELAY_ROLE`: This allows for changing the `executionDelay` period.
  > Note: Changing the execution delay does not affect current delays.
- `DELAY_EXECUTION_ROLE`: Any entity with this role can delay an intent.
- `PAUSE_EXECUTION_ROLE`: This allows for pausing a delay.
- `RESUME_EXECUTION_ROLE`: This allows for resuming a paused delay.
- `CANCEL_EXECUTION_ROLE`: This allows for cancelling a delay.

### Interface

Check out our [user guide](./docs/user-guide.md) to go through the functionality of the app.

## How to run the Delay app locally

Git clone this repo.

```sh
git clone https://github.com/1Hive/delay-app.git
```

Navigate into the `delay-app` directory.

```sh
cd delay-app
```

Install npm dependencies.

```sh
npm i
```

Deploy a dao with Delay app installed on your local environment.

```sh
npm run start:template
```

## Aragon DAO Installation

For a detailed step by step guide you can see [our installation guide](./docs/installation-guide.md)

To deploy to an organization you can use the [aragonCLI](https://hack.aragon.org/docs/cli-intro.html).

```sh
aragon dao install <dao-address> delay.aragonpm.eth --app-init-args <delay-execution>
```

## Contributing

We welcome community contributions!

Please check out our [open Issues](https://github.com/1Hive/delay-app/issues) to get started.

If you discover something that could potentially impact security, please notify us immediately. The quickest way to reach us is via the #dev channel in our [team Keybase chat](https://keybase.io/team/1hive). Just say hi and that you discovered a potential security vulnerability and we'll DM you to discuss details.
