const Delay = artifacts.require('Delay')
const ExecutionTarget = artifacts.require('ExecutionTarget')
import DaoDeployment from './helpers/DaoDeployment'
import { deployedContract, assertRevert, timeTravel } from './helpers/helpers'
import { encodeCallScript } from '@aragon/test-helpers/evmScript'

contract('Delay', ([rootAccount, ...accounts]) => {
  let daoDeployment = new DaoDeployment()
  let delayBase, delay
  let SET_DELAY_ROLE, DELAY_EXECUTION_ROLE, PAUSE_EXECUTION_ROLE, RESUME_EXECUTION_ROLE, CANCEL_EXECUTION_ROLE

  before(async () => {
    await daoDeployment.deployBefore()

    delayBase = await Delay.new()
    SET_DELAY_ROLE = await delayBase.SET_DELAY_ROLE()
    DELAY_EXECUTION_ROLE = await delayBase.DELAY_EXECUTION_ROLE()
    PAUSE_EXECUTION_ROLE = await delayBase.PAUSE_EXECUTION_ROLE()
    RESUME_EXECUTION_ROLE = await delayBase.RESUME_EXECUTION_ROLE()
    CANCEL_EXECUTION_ROLE = await delayBase.CANCEL_EXECUTION_ROLE()
  })

  beforeEach(async () => {
    await daoDeployment.deployBeforeEach(rootAccount)
    const newAppReceipt = await daoDeployment.kernel.newAppInstance('0x1234', delayBase.address, '0x', false, {
      from: rootAccount,
    })
    delay = await Delay.at(deployedContract(newAppReceipt))

    await daoDeployment.acl.createPermission(rootAccount, delay.address, DELAY_EXECUTION_ROLE, rootAccount)
    await daoDeployment.acl.createPermission(rootAccount, delay.address, PAUSE_EXECUTION_ROLE, rootAccount)
    await daoDeployment.acl.createPermission(rootAccount, delay.address, RESUME_EXECUTION_ROLE, rootAccount)
    await daoDeployment.acl.createPermission(rootAccount, delay.address, CANCEL_EXECUTION_ROLE, rootAccount)
  })

  describe('initialize(uint256 _executionDelay)', () => {
    const INITIAL_DELAY = 100 // seconds

    beforeEach(async () => {
      await delay.initialize(INITIAL_DELAY)
    })

    it('sets the initial delay correctly and initializes', async () => {
      const actualExecutionDelay = await delay.executionDelay()
      const hasInitialized = await delay.hasInitialized()
      assert.equal(actualExecutionDelay, INITIAL_DELAY)
      assert.isTrue(hasInitialized)
    })

    it('delay app is a forwarder', async () => {
      assert.isTrue(await delay.isForwarder())
    })

    describe('setExecutionDelay(uint256 _executionDelay)', () => {
      it('sets the execution delay correctly', async () => {
        await daoDeployment.acl.createPermission(rootAccount, delay.address, SET_DELAY_ROLE, rootAccount)
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
        await daoDeployment.acl.revokePermission(rootAccount, delay.address, DELAY_EXECUTION_ROLE)
        assert.isFalse(await delay.canForward(rootAccount, '0x'))
      })
    })

    describe('submit a delayed execution script', () => {
      let executionTarget, script

      beforeEach(async () => {
        executionTarget = await ExecutionTarget.new()
        const action = {
          to: executionTarget.address,
          calldata: executionTarget.contract.methods.execute().encodeABI(),
        }
        script = encodeCallScript([action])
      })

      describe('delayExecution(bytes _evmCallScript)', () => {
        beforeEach(async () => {
          await delay.delayExecution(script)
        })

        it('stores delayed execution script and updates new script index', async () => {
          const { timestamp } = await web3.eth.getBlock('latest')
          const expectedExecutionTime = timestamp + INITIAL_DELAY

          const { executionTime: actualExecutionTime, evmCallScript: actualCallScript } = await delay.delayedScripts(0)
          const actualNewScriptIndex = await delay.delayedScriptsNewIndex()

          assert.closeTo(actualExecutionTime.toNumber(), expectedExecutionTime, 3)
          assert.equal(actualCallScript, script)
          assert.equal(actualNewScriptIndex, 1)
        })

        describe('execute(uint256 _delayedScriptId)', () => {
          it('executes the script after the delay has elapsed and deletes script', async () => {
            await timeTravel(web3)(INITIAL_DELAY + 3)

            await delay.execute(0)
            const actualExecutionCounter = await executionTarget.counter()
            const {
              executionTime: actualExecutionTime,
              evmCallScript: actualCallScript,
              pausedAt: actualPausedAt,
            } = await delay.delayedScripts(0)
            assert.equal(actualExecutionCounter, 1)
            assert.equal(actualExecutionTime, 0)
            assert.equal(actualCallScript, null)
            assert.equal(actualPausedAt, 0)
          })
        })
      })

      describe('forward(bytes _evmCallScript)', () => {
        it('stores delayed execution script and updates new script index when permission granted', async () => {
          await delay.forward(script)
          const { timestamp } = await web3.eth.getBlock('latest')
          const expectedExecutionTime = timestamp + INITIAL_DELAY
          const {
            executionTime: actualExecutionTime,
            evmCallScript: actualCallScript,
            pausedAt: actualPausedAt,
          } = await delay.delayedScripts(0)
          const actualNewScriptIndex = await delay.delayedScriptsNewIndex()

          assert.closeTo(actualExecutionTime.toNumber(), expectedExecutionTime, 3)
          assert.equal(actualCallScript, script)
          assert.equal(actualPausedAt, 0)
          assert.equal(actualNewScriptIndex, 1)
        })

        it('reverts when permission revoked', async () => {
          await daoDeployment.acl.revokePermission(rootAccount, delay.address, DELAY_EXECUTION_ROLE)

          const forwardReceipt = delay.forward(script)

          await assertRevert(forwardReceipt, 'DELAY_CAN_NOT_FORWARD')
        })

        describe('pauseExecution(uint256 _delayedScriptId)', () => {
          beforeEach('create delayed script', async () => {
            await delay.forward(script)
          })

          it('pauses execution script', async () => {
            const { timestamp } = await web3.eth.getBlock('latest')
            await delay.pauseExecution(0)

            const { pausedAt } = await delay.delayedScripts(0)

            assert.closeTo(pausedAt.toNumber(), timestamp, 3)
          })

          it('reverts when pausing non existent script', async () => {
            await assertRevert(delay.pauseExecution(1), 'DELAY_NO_SCRIPT')
          })

          it('reverts when pausing already paused script execution', async () => {
            await delay.pauseExecution(0)
            await assertRevert(delay.pauseExecution(0), 'DELAY_CAN_NOT_PAUSE')
          })

          it('reverts when pausing after script executionTime', async () => {
            await timeTravel(web3)(INITIAL_DELAY + 1)
            await assertRevert(delay.pauseExecution(0), 'DELAY_CAN_NOT_PAUSE')
          })
        })

        describe('resumeExecution(uint256 _delayedScriptId)', () => {
          beforeEach('create delayed script', async () => {
            await delay.forward(script)
          })

          it('resumes execution script', async () => {
            const timePaused = 50
            const { executionTime: oldExecutionTime } = await delay.delayedScripts(0)

            await delay.pauseExecution(0)
            await timeTravel(web3)(timePaused)
            await delay.resumeExecution(0)

            const { executionTime: actualExecutionTime, pausedAt: actualPausedAt } = await delay.delayedScripts(0)
            assert.equal(actualPausedAt, 0)
            assert.closeTo(actualExecutionTime.toNumber(), oldExecutionTime.toNumber() + timePaused, 3)
          })

          it('reverts when resuming non existent script', async () => {
            await assertRevert(delay.resumeExecution(1), 'DELAY_NO_SCRIPT')
          })

          it('reverts when resuming non paused script execution', async () => {
            await assertRevert(delay.resumeExecution(0), 'DELAY_CAN_NOT_RESUME')
          })
        })

        describe('cancelExecution(uint256 _delayedScriptId)', () => {
          beforeEach('create delayed script', async () => {
            await delay.forward(script)
          })

          it('cancels execution script', async () => {
            await delay.cancelExecution(0)

            const {
              executionTime: actualExecutionTime,
              evmCallScript: actualCallScript,
              pausedAt: actualPausedAt,
            } = await delay.delayedScripts(0)

            assert.equal(actualExecutionTime, 0)
            assert.equal(actualCallScript, null)
            assert.equal(actualPausedAt, 0)
          })
        })

        describe('execute(uint256 _delayedScriptId)', () => {
          beforeEach('create delayed script', async () => {
            await delay.forward(script)
          })

          it('executes the script after the delay has elapsed and deletes script', async () => {
            await timeTravel(web3)(INITIAL_DELAY + 3)

            await delay.execute(0)
            const actualExecutionCounter = await executionTarget.counter()
            const {
              executionTime: actualExecutionTime,
              evmCallScript: actualCallScript,
              pausedAt: actualPausedAt,
            } = await delay.delayedScripts(0)
            assert.equal(actualExecutionCounter, 1)
            assert.equal(actualExecutionTime, 0)
            assert.equal(actualCallScript, null)
            assert.equal(actualPausedAt, 0)
          })

          it('executes the script after execution is resumed', async () => {
            await timeTravel(web3)(INITIAL_DELAY - 3)
            await delay.pauseExecution(0)
            await delay.resumeExecution(0)

            await timeTravel(web3)(4)
            await delay.execute(0)
          })

          it('reverts when script does not exist', async () => {
            await assertRevert(delay.execute(1), 'DELAY_NO_SCRIPT')
          })

          it('reverts when executing script before execution time', async () => {
            await assertRevert(delay.execute(0), 'DELAY_CAN_NOT_EXECUTE')
          })

          it('reverts when executing paused script', async () => {
            await delay.pauseExecution(0)

            await timeTravel(web3)(INITIAL_DELAY + 3)
            await assertRevert(delay.execute(0), 'DELAY_CAN_NOT_EXECUTE')
          })

          it('reverts when executing cancelled script', async () => {
            await timeTravel(web3)(INITIAL_DELAY + 3)
            await delay.cancelExecution(0)

            await assertRevert(delay.execute(0), 'DELAY_NO_SCRIPT')
          })
        })
      })
    })
  })

  describe('app not initialized', async () => {
    it('reverts on setting execution delay', async () => {
      await assertRevert(delay.setExecutionDelay())
    })

    it('reverts on creating delay execution script (delayExecution)', async () => {
      await assertRevert(delay.delayExecution())
    })

    it('reverts on creating delay execution script (forward)', async () => {
      await assertRevert(delay.forward())
    })
  })
})
