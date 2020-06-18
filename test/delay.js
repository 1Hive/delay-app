const Delay = artifacts.require('MockDelay')
const ExecutionTarget = artifacts.require('ExecutionTarget')

const { assertRevert } = require('@aragon/apps-agreement/test/helpers/assert/assertThrow')
const { ACTIONS_STATE, RULINGS } = require('@aragon/apps-agreement/test/helpers/utils/enums')
const { encodeCallScript } = require('@aragon/contract-test-helpers/evmScript')
const { getEventArgument, getNewProxyAddress } = require('@aragon/contract-test-helpers/events')
const { hash: nameHash } = require('eth-ens-namehash')

const deployer = require('@aragon/apps-agreement/test/helpers/utils/deployer')(web3, artifacts)

const ONE_DAY = 60 * 60 * 24
const ANY_ADDR = '0xffffffffffffffffffffffffffffffffffffffff'

const DELAYED_SCRIPT_STATUS = {
  ACTIVE: 0,
  PAUSED: 1,
  CANCELLED: 2,
  EXECUTED: 3
}

contract('Delay', ([rootAccount]) => {
  let agreement, collateralToken, delayBase, delay
  let SET_DELAY_ROLE, DELAY_EXECUTION_ROLE, SET_AGREEMENT_ROLE, CHALLENGE_ROLE

  before('deploy base apps', async () => {
    delayBase = await Delay.new()
    agreement = await deployer.deployAndInitializeWrapper({ rootAccount })
    collateralToken = await deployer.deployCollateralToken()
    await agreement.sign(rootAccount)

    SET_AGREEMENT_ROLE = await delayBase.SET_AGREEMENT_ROLE()
    SET_DELAY_ROLE = await delayBase.SET_DELAY_ROLE()
    CHALLENGE_ROLE = await deployer.base.CHALLENGE_ROLE()
    DELAY_EXECUTION_ROLE = await delayBase.DELAY_EXECUTION_ROLE()
  })

  beforeEach('deploy dao and delay', async () => {
    const newDelayAppReceipt =
      await deployer.dao.newAppInstance(nameHash('delay.aragonpm.eth'), delayBase.address, '0x', false, {from: rootAccount,})
    delay = await Delay.at(getNewProxyAddress(newDelayAppReceipt))

    await deployer.acl.createPermission(agreement.address, delay.address, SET_AGREEMENT_ROLE, rootAccount)
    await deployer.acl.createPermission(ANY_ADDR, delay.address, CHALLENGE_ROLE, rootAccount)
    await deployer.acl.createPermission(rootAccount, delay.address, DELAY_EXECUTION_ROLE, rootAccount)
  })

  describe('initialize(uint256 _executionDelay)', () => {
    const DELAY_LENGTH = 1000 // seconds

    beforeEach(async () => {
      await delay.initialize(DELAY_LENGTH)
      await agreement.activate({ disputable: delay, collateralToken, actionCollateral: 0, challengeCollateral: 0, challengeDuration: DELAY_LENGTH, from: rootAccount })
    })

    it('sets the initial delay correctly and initializes', async () => {
      const actualExecutionDelay = await delay.executionDelay()
      const hasInitialized = await delay.hasInitialized()
      assert.equal(actualExecutionDelay, DELAY_LENGTH)
      assert.isTrue(hasInitialized)
    })

    it('delay app is a forwarder', async () => {
      assert.isTrue(await delay.isForwarder())
    })

    describe('setExecutionDelay(uint256 _executionDelay)', () => {
      it('sets the execution delay correctly', async () => {
        await deployer.acl.createPermission(rootAccount, delay.address, SET_DELAY_ROLE, rootAccount)
        const expectedExecutionDelay = 20

        await delay.setExecutionDelay(expectedExecutionDelay)

        const actualExecutionDelay = await delay.executionDelay()
        assert.equal(actualExecutionDelay, expectedExecutionDelay)
      })
    })

    describe('canForward(address _sender, bytes _evmCallScript)', () => {
      it('returns true when permission has been set', async () => {
        assert.isTrue(await delay.canForward(rootAccount, '0x'))
      })

      it('returns false when permission has been revoked', async () => {
        await deployer.acl.revokePermission(rootAccount, delay.address, DELAY_EXECUTION_ROLE)
        assert.isFalse(await delay.canForward(rootAccount, '0x'))
      })
    })

    describe('submit a delayed execution script', () => {
      let executionTarget, script, delayedScriptId, actionId, delayCreatedTimestamp

      beforeEach(async () => {
        executionTarget = await ExecutionTarget.new()
        const action = {
          to: executionTarget.address,
          calldata: executionTarget.contract.methods.execute().encodeABI(),
        }
        script = encodeCallScript([action])
      })

      const itUpdatesExecutionStateCorrectly = () => {

        it('stores delayed execution script and updates new script index', async () => {
          const timestamp = await delay.getTimestampPublic()

          const expectedExecutionFromTime = timestamp.toNumber() + DELAY_LENGTH
          const {
            executionFromTime: actualExecutionFromTime,
            pausedAt: actualPausedAt,
            evmCallScript: actualCallScript,
            delayedScriptStatus
          } = await delay.delayedScripts(delayedScriptId)
          const actualNewScriptIndex = await delay.delayedScriptsNewIndex()

          assert.closeTo(actualExecutionFromTime.toNumber(), expectedExecutionFromTime, 3)
          assert.equal(actualCallScript, script)
          assert.equal(actualPausedAt, 0)
          assert.equal(actualNewScriptIndex, 1)
          assert.equal(delayedScriptStatus, DELAYED_SCRIPT_STATUS.ACTIVE)
        })

        describe('getDisputableAction(uint256 _delayedScriptId)', () => {
          it('returns expected values for unexecuted script', async () => {
            const { endDate, challenged, finished } = await delay.getDisputableAction(delayedScriptId)

            assert.closeTo(endDate.toNumber(), delayCreatedTimestamp.toNumber() + DELAY_LENGTH, 3)
            assert.isFalse(challenged)
            assert.isFalse(finished)
          })

          it('returns expected values for unexecuted challenged script', async () => {
            await agreement.challenge({ actionId })

            const { endDate, challenged, finished } = await delay.getDisputableAction(delayedScriptId)

            assert.closeTo(endDate.toNumber(), delayCreatedTimestamp.toNumber() + DELAY_LENGTH, 3)
            assert.isTrue(challenged)
            assert.isFalse(finished)
          })

          it('returns expected values for finished script', async () => {
            await agreement.challenge({ actionId })
            await agreement.dispute({ actionId })
            await agreement.executeRuling({ actionId, ruling: RULINGS.IN_FAVOR_OF_CHALLENGER })

            const { endDate, challenged, finished } = await delay.getDisputableAction(delayedScriptId)

            assert.closeTo(endDate.toNumber(), delayCreatedTimestamp.toNumber() + DELAY_LENGTH, 3)
            assert.isFalse(challenged)
            assert.isTrue(finished)
          })
        })

        describe('canChallenge(uint256 _delayedScriptId)', () => {
          it('returns true when script not paused', async () => {
            const canChallenge = await delay.canChallenge(delayedScriptId)
            assert.isTrue(canChallenge)
          })

          it('returns false when script is paused', async () => {
            await agreement.challenge({ actionId })
            const canChallenge = await delay.canChallenge(delayedScriptId)
            assert.isFalse(canChallenge)
          })

          it('returns false when script is executable', async () => {
            await delay.mockIncreaseTime(DELAY_LENGTH)
            const canChallenge = await delay.canChallenge(delayedScriptId)
            assert.isFalse(canChallenge)
          })
        })

        describe('canClose(uint256 _delayedScriptId)', () => {
          it('returns false when script is not executable', async () => {
            const canClose = await delay.canClose(delayedScriptId)
            assert.isFalse(canClose)
          })

          it('returns true when script is executable', async () => {
            await delay.mockIncreaseTime(DELAY_LENGTH)
            const canClose = await delay.canClose(delayedScriptId)
            assert.isTrue(canClose)
          })
        })

        describe('_onDisputableActionChallenged(uint256 _delayedScriptId)', () => {
          it('pauses execution script', async () => {
            const timestamp = await delay.getTimestampPublic()

            await agreement.challenge({ actionId })

            const { pausedAt, delayedScriptStatus } = await delay.delayedScripts(delayedScriptId)
            assert.closeTo(pausedAt.toNumber(), timestamp.toNumber(), 3)
            assert.equal(delayedScriptStatus, DELAYED_SCRIPT_STATUS.PAUSED)
          })

          it('reverts when challenging non existent action', async () => {
            const incorrectActionId = 99
            await assertRevert(agreement.challenge({ actionId: incorrectActionId }), 'AGR_ACTION_DOES_NOT_EXIST')
          })

          it('reverts when challenging already paused script execution', async () => {
            await agreement.challenge({ actionId })
            await assertRevert(agreement.challenge({ actionId }), 'AGR_CANNOT_CHALLENGE_ACTION')
          })

          it('reverts when challenging script past execution time', async () => {
            await delay.mockIncreaseTime(DELAY_LENGTH)
            await assertRevert(agreement.challenge({ actionId }), 'AGR_CANNOT_CHALLENGE_ACTION')
          })

          it('allows multiple challenges', async () => {
            await agreement.challenge({ actionId })
            await agreement.dispute({ actionId })
            await agreement.executeRuling({ actionId, ruling: RULINGS.IN_FAVOR_OF_SUBMITTER })
            const timestamp = await delay.getTimestampPublic()

            await agreement.challenge({ actionId })

            const { pausedAt, delayedScriptStatus } = await delay.delayedScripts(delayedScriptId)
            assert.closeTo(pausedAt.toNumber(), timestamp.toNumber(), 3) // Is not exact due to agreement.challenge() executing multiple transactions
            assert.equal(delayedScriptStatus, DELAYED_SCRIPT_STATUS.PAUSED)
          })
        })

        describe('_onDisputableActionAllowed(uint256 _delayedScriptId)', () => {
          it('resumes execution script', async () => {
            const timePaused = 50
            const { executionFromTime: oldExecutionFromTime } = await delay.delayedScripts(delayedScriptId)

            await agreement.challenge({ actionId })
            await agreement.dispute({ actionId })
            await delay.mockIncreaseTime(timePaused)
            await agreement.executeRuling({ actionId, ruling: RULINGS.IN_FAVOR_OF_SUBMITTER })

            const {
              executionFromTime: actualExecutionFromTime,
              pausedAt: actualPausedAt,
              delayedScriptStatus
            } = await delay.delayedScripts(delayedScriptId)
            assert.equal(actualPausedAt, 0)
            assert.closeTo(actualExecutionFromTime.toNumber(), oldExecutionFromTime.toNumber() + timePaused, 5)
            assert.equal(delayedScriptStatus, DELAYED_SCRIPT_STATUS.ACTIVE)
          })

          it('reverts when disputing non existent script', async () => {
            const incorrectActionId = 99
            await assertRevert(agreement.dispute({ actionId }), 'AGR_CANNOT_DISPUTE_ACTION')
          })

          it('reverts when attempting to reject after being allowed', async () => {
            await agreement.challenge({ actionId })
            await agreement.dispute({ actionId })
            await agreement.executeRuling({ actionId, ruling: RULINGS.IN_FAVOR_OF_SUBMITTER })
            await assertRevert(agreement.executeRuling({ actionId, ruling: RULINGS.IN_FAVOR_OF_CHALLENGER }), 'AGR_CANNOT_RULE_ACTION')
          })
        })

        describe('_onDisputableActionRejected(uint256 _delayedScriptId)', () => {
          it('cancels execution script', async () => {
            await agreement.challenge({ actionId })
            await agreement.dispute({ actionId })
            await agreement.executeRuling({ actionId, ruling: RULINGS.IN_FAVOR_OF_CHALLENGER })

            const {
              executionFromTime: actualExecutionFromTime,
              evmCallScript: actualCallScript,
              delayedScriptStatus
            } = await delay.delayedScripts(delayedScriptId)

            assert.closeTo(actualExecutionFromTime.toNumber(), delayCreatedTimestamp.toNumber() + DELAY_LENGTH, 3)
            assert.equal(actualCallScript, script)
            assert.equal(delayedScriptStatus, DELAYED_SCRIPT_STATUS.CANCELLED)
          })

          it('reverts when attempting to allow after being rejected', async () => {
            await agreement.challenge({ actionId })
            await agreement.dispute({ actionId })
            await agreement.executeRuling({ actionId, ruling: RULINGS.IN_FAVOR_OF_CHALLENGER })
            await assertRevert(agreement.executeRuling({ actionId, ruling: RULINGS.IN_FAVOR_OF_SUBMITTER }), 'AGR_CANNOT_RULE_ACTION')
          })

          it('closes the action', async () => {
            await agreement.challenge({ actionId })
            await agreement.dispute({ actionId })
            await agreement.executeRuling({ actionId, ruling: RULINGS.IN_FAVOR_OF_CHALLENGER })

            const { closed } = await agreement.getAction(actionId)
            assert.isTrue(closed)
          })
        })

        describe('_onDisputableActionVoided(uint256 _delayedScriptId)', async () => {
          it('resumes execution script', async () => {
            const timePaused = 50
            const { executionFromTime: oldExecutionFromTime } = await delay.delayedScripts(delayedScriptId)

            await agreement.challenge({ actionId })
            await agreement.dispute({ actionId })
            await delay.mockIncreaseTime(timePaused)
            await agreement.executeRuling({ actionId, ruling: RULINGS.REFUSED })

            const {
              executionFromTime: actualExecutionFromTime,
              pausedAt: actualPausedAt,
              delayedScriptStatus
            } = await delay.delayedScripts(delayedScriptId)
            assert.equal(actualPausedAt, 0)
            assert.closeTo(actualExecutionFromTime.toNumber(), oldExecutionFromTime.toNumber() + timePaused, 5)
            assert.equal(delayedScriptStatus, DELAYED_SCRIPT_STATUS.ACTIVE)
          })
        })

        describe('execute(uint256 _delayedScriptId)', () => {
          it('executes the script after the delay has elapsed', async () => {
            await delay.mockIncreaseTime(DELAY_LENGTH)

            await delay.execute(delayedScriptId)
            const actualExecutionCounter = await executionTarget.counter()
            const {
              executionFromTime: actualExecutionFromTime,
              evmCallScript: actualCallScript,
              delayedScriptStatus
            } = await delay.delayedScripts(delayedScriptId)

            assert.equal(actualExecutionCounter, 1)
            assert.closeTo(actualExecutionFromTime.toNumber(), delayCreatedTimestamp.toNumber() + DELAY_LENGTH, 3)
            assert.equal(actualCallScript, script)
            assert.equal(delayedScriptStatus, DELAYED_SCRIPT_STATUS.EXECUTED)
          })

          it('executes the script after execution is resumed', async () => {
            await agreement.challenge({ actionId })
            await agreement.dispute({ actionId })
            await agreement.executeRuling({ actionId, ruling: RULINGS.IN_FAVOR_OF_SUBMITTER })

            await delay.mockIncreaseTime(DELAY_LENGTH)
            await delay.execute(delayedScriptId)
          })

          it('reverts when script does not exist', async () => {
            const incorrectScriptId = 99
            await assertRevert(delay.execute(incorrectScriptId), 'DELAY_CANNOT_EXECUTE')
          })

          it('reverts when executing script before execution time', async () => {
            await assertRevert(delay.execute(delayedScriptId), 'DELAY_CANNOT_EXECUTE')
          })

          it('reverts when executing paused script', async () => {
            await agreement.challenge({ actionId })
            await delay.mockIncreaseTime(DELAY_LENGTH)
            await assertRevert(delay.execute(delayedScriptId), 'DELAY_CANNOT_EXECUTE')
          })

          it('reverts when executing cancelled script', async () => {
            await agreement.challenge({ actionId })
            await agreement.dispute({ actionId })
            await agreement.executeRuling({ actionId, ruling: RULINGS.IN_FAVOR_OF_CHALLENGER })
            await delay.mockIncreaseTime(DELAY_LENGTH)

            await assertRevert(delay.execute(delayedScriptId), 'DELAY_CANNOT_EXECUTE')
          })

          it('reverts when evmScript reenters delay contract, attempting to execute same script twice', async () => {
            const action = {
              to: delay.address,
              calldata: delay.contract.methods.execute(1).encodeABI(),
            }
            const reenteringScript = encodeCallScript([action])

            const delayReceipt = await delay.delayExecution("0x", reenteringScript)

            const scriptId = getEventArgument(delayReceipt, 'DelayedScriptStored', 'delayedScriptId')
            await delay.mockIncreaseTime(DELAY_LENGTH)
            await assertRevert(delay.execute(scriptId), 'REENTRANCY_REENTRANT_CALL')
          })

          it('reverts when evmScript calls function on Agreements contract', async () => {
            const action = {
              to: agreement.address,
              calldata: agreement.agreement.contract.methods.getDisputableInfo(delay.address).encodeABI(),
            }
            const agreementScript = encodeCallScript([action])

            const delayReceipt = await delay.delayExecution("0x", agreementScript)

            const scriptId = getEventArgument(delayReceipt, 'DelayedScriptStored', 'delayedScriptId')
            await delay.mockIncreaseTime(DELAY_LENGTH)
            await assertRevert(delay.execute(scriptId), 'EVMCALLS_BLACKLISTED_CALL')
          })

          it('closes the agreement action', async () => {
            const { closed: closedBefore } = await agreement.getAction(actionId)
            await delay.mockIncreaseTime(DELAY_LENGTH)

            await delay.execute(delayedScriptId)

            const { closed: closedAfter } = await agreement.getAction(actionId)
            assert.isFalse(closedBefore)
            assert.isTrue(closedAfter)
          })
        })

        describe('closeAgreementAction(uint256 _delayedScriptId)', () => {
          it('closes the agreement action', async () => {
            const { closed: closedBefore } = await agreement.getAction(actionId)
            await delay.mockIncreaseTime(DELAY_LENGTH)

            await delay.closeAgreementAction(delayedScriptId)

            const { closed: closedAfter } = await agreement.getAction(actionId)
            assert.isFalse(closedBefore)
            assert.isTrue(closedAfter)
          })

          it('reverts when cannot execute', async () => {
            await assertRevert(delay.closeAgreementAction(delayedScriptId), "DELAY_CANNOT_CLOSE")
          })

          it('reverts when already closed', async () => {
            await delay.mockIncreaseTime(DELAY_LENGTH)
            await delay.closeAgreementAction(delayedScriptId)
            await assertRevert(delay.closeAgreementAction(delayedScriptId), "AGR_CANNOT_CLOSE_ACTION")
          })

          describe('execute(uint256 _delayedScriptId)', () => {
            it('succeeds when action already closed', async () => {
              await delay.mockIncreaseTime(DELAY_LENGTH)
              await delay.closeAgreementAction(delayedScriptId)

              await delay.execute(delayedScriptId)

              const actualExecutionCounter = await executionTarget.counter()
              const {
                executionFromTime: actualExecutionFromTime,
                evmCallScript: actualCallScript,
                delayedScriptStatus
              } = await delay.delayedScripts(delayedScriptId)
              assert.equal(actualExecutionCounter, 1)
              assert.closeTo(actualExecutionFromTime.toNumber(), delayCreatedTimestamp.toNumber() + DELAY_LENGTH, 3)
              assert.equal(actualCallScript, script)
              assert.equal(delayedScriptStatus, DELAYED_SCRIPT_STATUS.EXECUTED)
            })
          })
        })
      }

      describe('delayExecution(bytes _evmCallScript)', () => {
        beforeEach(async () => {
          delayCreatedTimestamp = await delay.getTimestampPublic()
          const delayExecutionReceipt = await delay.delayExecution("0x", script)
          delayedScriptId = getEventArgument(delayExecutionReceipt, 'DelayedScriptStored', 'delayedScriptId')
          actionId = getEventArgument(delayExecutionReceipt, 'DelayedScriptStored', 'actionId')
        })

        it('reverts when permission revoked', async () => {
          await deployer.acl.revokePermission(rootAccount, delay.address, DELAY_EXECUTION_ROLE)
          await assertRevert(delay.delayExecution("0x", script), 'APP_AUTH_FAILED')
        })

        itUpdatesExecutionStateCorrectly()
      })

      describe('forward(bytes _evmCallScript)', () => {
        beforeEach('create delayed script', async () => {
          delayCreatedTimestamp = await delay.getTimestampPublic()
          const delayExecutionReceipt = await delay.forward(script)
          delayedScriptId = getEventArgument(delayExecutionReceipt, 'DelayedScriptStored', 'delayedScriptId')
          actionId = getEventArgument(delayExecutionReceipt, 'DelayedScriptStored', 'actionId')
        })

        it('reverts when permission revoked', async () => {
          await deployer.acl.revokePermission(rootAccount, delay.address, DELAY_EXECUTION_ROLE)
          await assertRevert(delay.forward(script), 'DELAY_CANNOT_FORWARD')
        })

        itUpdatesExecutionStateCorrectly()
      })
    })
  })

  describe('app not initialized', async () => {
    let script

    beforeEach(async () => {
      const executionTarget = await ExecutionTarget.new()
      const action = {
        to: executionTarget.address,
        calldata: executionTarget.contract.methods.execute().encodeABI(),
      }
      script = encodeCallScript([action])
    })

    it('reverts on setting execution delay', async () => {
      await assertRevert(delay.setExecutionDelay(10), "APP_AUTH_FAILED")
    })

    it('reverts on creating delay execution script (delayExecution)', async () => {
      await assertRevert(delay.delayExecution("0x", script), "APP_AUTH_FAILED")
    })

    it('reverts on creating delay execution script (forward)', async () => {
      await assertRevert(delay.forward(script), "DELAY_CANNOT_FORWARD")
    })
  })
})
