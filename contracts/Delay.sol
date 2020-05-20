pragma solidity ^0.4.24;

import "@aragon/os/contracts/apps/AragonApp.sol";
import "@aragon/os/contracts/common/IForwarder.sol";
import "@aragon/os/contracts/lib/math/SafeMath64.sol";

import "@aragon/apps-agreement/contracts/disputable/DisputableApp.sol";


contract Delay is DisputableApp {
    using SafeMath64 for uint64;

    bytes32 public constant SET_DELAY_ROLE = keccak256("SET_DELAY_ROLE");
    bytes32 public constant DELAY_EXECUTION_ROLE = keccak256("DELAY_EXECUTION_ROLE");
    bytes32 public constant PAUSE_EXECUTION_ROLE = keccak256("PAUSE_EXECUTION_ROLE");
    bytes32 public constant RESUME_EXECUTION_ROLE = keccak256("RESUME_EXECUTION_ROLE");
    bytes32 public constant CANCEL_EXECUTION_ROLE = keccak256("CANCEL_EXECUTION_ROLE");

    string private constant ERROR_NO_SCRIPT = "DELAY_NO_SCRIPT";
    string private constant ERROR_SCRIPT_NOT_PAUSED = "DELAY_SCRIPT_NOT_PAUSED";
    string private constant ERROR_CAN_NOT_PROCEED = "DELAY_CAN_NOT_PROCEED";
    string private constant ERROR_CAN_NOT_EXECUTE = "DELAY_CAN_NOT_EXECUTE";
    string private constant ERROR_CAN_NOT_PAUSE = "DELAY_CAN_NOT_PAUSE";
    string private constant ERROR_SCRIPT_EXECUTION_PASSED = "DELAY_SCRIPT_EXECUTION_PASSED";
    string private constant ERROR_CAN_NOT_RESUME = "DELAY_CAN_NOT_RESUME";
    string private constant ERROR_CAN_NOT_FORWARD = "DELAY_CAN_NOT_FORWARD";

    struct DelayedScript {
        uint64 executionTime;
        uint64 pausedAt;
        bytes evmCallScript;
        uint256 actionId;
    }

    uint64 public executionDelay;
    uint256 public delayedScriptsNewIndex = 0;
    mapping (uint256 => DelayedScript) public delayedScripts;

    event DelayedScriptStored(uint256 scriptId);
    event ExecutionDelaySet(uint64 executionDelay);
    event ExecutedScript(uint256 scriptId);
    event ExecutionPaused(uint256 scriptId);
    event ExecutionResumed(uint256 scriptId);
    event ExecutionCancelled(uint256 scriptId);

    modifier scriptExists(uint256 _scriptId) {
        require(delayedScripts[_scriptId].executionTime != 0, ERROR_NO_SCRIPT);
        _;
    }

    /**
    * @notice Initialize the Delay app
    * @param _executionDelay The delay in seconds a user will have to wait before executing a script
    */
    function initialize(uint64 _executionDelay) external onlyInit {
        initialized();
        executionDelay = _executionDelay;
    }

    /**
    * @notice Set the execution delay to `_executionDelay`
    * @param _executionDelay The new execution delay
    */
    function setExecutionDelay(uint64 _executionDelay) external auth(SET_DELAY_ROLE) {
        executionDelay = _executionDelay;

        emit ExecutionDelaySet(executionDelay);
    }

    /**
    * @notice Delays execution for `@transformTime(self.executionDelay(): uint)`
    * @param _context Information context for the script being scheduled
    * @param _evmCallScript The script that can be executed after a delay
    */
    function delayExecution(bytes _context, bytes _evmCallScript) external auth(DELAY_EXECUTION_ROLE) returns (uint256) {
        return _delayExecution(_context, _evmCallScript);
    }

    /**
    * @notice Pause the script execution with ID `_delayedScriptId`
    * @param _delayedScriptId The ID of the script execution to pause
    */
    function pauseExecution(uint256 _delayedScriptId) external auth(PAUSE_EXECUTION_ROLE) {
        _pauseExecution(_delayedScriptId);
    }

    /**
    * @notice Resume a paused script execution with ID `_delayedScriptId`
    * @param _delayedScriptId The ID of the script execution to resume
    */
    function resumeExecution(uint256 _delayedScriptId) external auth(RESUME_EXECUTION_ROLE) {
        require(_canProceed(_delayedScriptId), ERROR_CAN_NOT_PROCEED);
        _resumeExecution(_delayedScriptId);
    }

    /**
    * @notice Cancel script execution with ID `_delayedScriptId`
    * @param _delayedScriptId The ID of the script execution to cancel
    */
    function cancelExecution(uint256 _delayedScriptId) external scriptExists(_delayedScriptId) auth(CANCEL_EXECUTION_ROLE) {
        require(_canProceed(_delayedScriptId), ERROR_CAN_NOT_PROCEED);
        _cancelExecution(_delayedScriptId);
        _closeAction(delayedScripts[_delayedScriptId].actionId);
    }

    /**
    * @notice Execute the script with ID `_delayedScriptId`
    * @param _delayedScriptId The ID of the script to execute
    */
    function execute(uint256 _delayedScriptId) external {
        require(canExecute(_delayedScriptId), ERROR_CAN_NOT_EXECUTE);

        DelayedScript memory delayedScript = delayedScripts[_delayedScriptId];
        delete delayedScripts[_delayedScriptId];

        runScript(delayedScript.evmCallScript, new bytes(0), new address[](0));
        emit ExecutedScript(_delayedScriptId);
        _closeAction(delayedScript.actionId);
    }

    /**
    * @notice Return whether a script with ID #`_scriptId` can be executed
    * @param _scriptId The ID of the script to execute
    */
    function canExecute(uint256 _scriptId) public view returns (bool) {
        bool withinExecutionWindow = getTimestamp64() > delayedScripts[_scriptId].executionTime;
        bool isUnpaused = !_isExecutionPaused(_scriptId);

        return withinExecutionWindow && isUnpaused && _canProceed(_scriptId);
    }

    function canForward(address _sender, bytes) public view returns (bool) {
        return canPerform(_sender, DELAY_EXECUTION_ROLE, arr());
    }

    /**
    * @notice Delays execution for `@transformTime(self.executionDelay(): uint)`
    * @param _evmCallScript The script that can be executed after a delay
    */
    function forward(bytes _evmCallScript) public {
        require(canForward(msg.sender, _evmCallScript), ERROR_CAN_NOT_FORWARD);
        _delayExecution(new bytes(0), _evmCallScript);
    }

    /**
    * @dev Challenge script execution
    * @param _delayedScriptId The ID of the script execution to challenge
    */
    function _onDisputableChallenged(uint256 _delayedScriptId, address /* _challenger */) internal {
        _pauseExecution(_delayedScriptId);
    }

    /**
    * @dev Allow script execution
    * @param _delayedScriptId The ID of the script execution to allow
    */
    function _onDisputableAllowed(uint256 _delayedScriptId) internal {
        _resumeExecution(_delayedScriptId);
    }

    /**
    * @dev Reject script execution
    * @param _delayedScriptId The ID of the script execution to reject
    */
    function _onDisputableRejected(uint256 _delayedScriptId) internal {
        require(_isExecutionPaused(_delayedScriptId), ERROR_SCRIPT_NOT_PAUSED);
        _cancelExecution(_delayedScriptId);
    }

    /**
    * @dev Void script execution
    * @param _delayedScriptId The ID of the script execution to void
    */
    function _onDisputableVoided(uint256 _delayedScriptId) internal {
        _onDisputableRejected(_delayedScriptId);
    }

    function _isExecutionPaused(uint256 _scriptId) internal view scriptExists(_scriptId) returns (bool) {
        return delayedScripts[_scriptId].pausedAt != 0;
    }

    function _delayExecution(bytes _context, bytes _evmCallScript) internal returns (uint256) {
        uint256 delayedScriptIndex = delayedScriptsNewIndex;
        delayedScriptsNewIndex++;

        uint256 actionId = _newAction(delayedScriptIndex, msg.sender, _context);
        delayedScripts[delayedScriptIndex] = DelayedScript(getTimestamp64().add(executionDelay), 0, _evmCallScript, actionId);

        emit DelayedScriptStored(delayedScriptIndex);
        return delayedScriptIndex;
    }

    function _pauseExecution(uint256 _delayedScriptId) internal {
        DelayedScript storage delayedScript = delayedScripts[_delayedScriptId];
        require(!_isExecutionPaused(_delayedScriptId), ERROR_CAN_NOT_PAUSE);
        require(getTimestamp64() < delayedScript.executionTime, ERROR_SCRIPT_EXECUTION_PASSED);

        delayedScript.pausedAt = getTimestamp64();

        emit ExecutionPaused(_delayedScriptId);
    }

    function _resumeExecution(uint256 _delayedScriptId) internal {
        require(_isExecutionPaused(_delayedScriptId), ERROR_CAN_NOT_RESUME);
        DelayedScript storage delayedScript = delayedScripts[_delayedScriptId];

        uint64 timePaused = getTimestamp64().sub(delayedScript.pausedAt);
        delayedScript.executionTime = delayedScript.executionTime.add(timePaused);
        delayedScript.pausedAt = 0;

        emit ExecutionResumed(_delayedScriptId);
    }

    function _cancelExecution(uint256 _delayedScriptId) internal {
        delete delayedScripts[_delayedScriptId];

        emit ExecutionCancelled(_delayedScriptId);
    }
}
