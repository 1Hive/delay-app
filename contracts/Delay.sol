pragma solidity ^0.4.24;

import "@aragon/os/contracts/apps/AragonApp.sol";
import "@aragon/os/contracts/common/IForwarder.sol";
import "@aragon/os/contracts/lib/math/SafeMath.sol";


contract Delay is AragonApp, IForwarder {
    using SafeMath for uint256;

    bytes32 public constant SET_DELAY_ROLE = keccak256("SET_DELAY_ROLE");
    bytes32 public constant DELAY_EXECUTION_ROLE = keccak256("DELAY_EXECUTION_ROLE");
    bytes32 public constant PAUSE_EXECUTION_ROLE = keccak256("PAUSE_EXECUTION_ROLE");
    bytes32 public constant RESUME_EXECUTION_ROLE = keccak256("RESUME_EXECUTION_ROLE");
    bytes32 public constant CANCEL_EXECUTION_ROLE = keccak256("CANCEL_EXECUTION_ROLE");


    string private constant ERROR_NO_SCRIPT = "DELAY_NO_SCRIPT";
    string private constant ERROR_CAN_NOT_EXECUTE = "DELAY_CAN_NOT_EXECUTE";
    string private constant ERROR_CAN_NOT_PAUSE = "DELAY_CAN_NOT_PAUSE";
    string private constant ERROR_CAN_NOT_RESUME = "DELAY_CAN_NOT_RESUME";
    string private constant ERROR_CAN_NOT_FORWARD = "DELAY_CAN_NOT_FORWARD";

    struct DelayedScript {
        uint256 executionTime;
        bytes evmCallScript;
        uint256 pausedAt;
    }

    uint256 public executionDelay;
    uint256 public delayedScriptsNewIndex = 0;
    mapping(uint256 => DelayedScript) public delayedScripts;

    event DelayedScriptStored(uint256 scriptId);
    event ExecutedScript(uint256 scriptId);
    event ExecutionPaused(uint256 scriptId);
    event ExecutionResumed(uint256 scriptId);
    event ExecutionCancelled(uint256 scriptId);
    event ChangeExecutionDelay(uint256 executionDelay);

    modifier scriptExists(uint256 _scriptId) {
        require(delayedScripts[_scriptId].executionTime != 0, ERROR_NO_SCRIPT);
        _;
    }

    /**
    * @notice Initialize the Delay app
    * @param _executionDelay The delay in seconds a user will have to wait before executing a script
    */
    function initialize(uint256 _executionDelay) external onlyInit {
        initialized();
        executionDelay = _executionDelay;
    }

    /**
    * @notice Set the execution delay to `_executionDelay`
    * @param _executionDelay The new execution delay
    */
    function setExecutionDelay(uint256 _executionDelay) external auth(SET_DELAY_ROLE) {
        executionDelay = _executionDelay;

        emit ChangeExecutionDelay(executionDelay);
    }

    /**
    * @notice Store script `_evmCallScript` for delayed execution
    * @param _evmCallScript The script that can be executed after a delay
    */
    function delayExecution(bytes _evmCallScript) external auth(DELAY_EXECUTION_ROLE) returns (uint256) {
        return _delayExecution(_evmCallScript);
    }

    function isForwarder() external pure returns (bool) {
        return true;
    }

    function canForward(address _sender, bytes) public view returns (bool) {
        return canPerform(_sender, DELAY_EXECUTION_ROLE, arr());
    }

    /**
    * @notice Store script `_evmCallScript` for delayed execution
    * @param _evmCallScript The script that can be executed after a delay
    */
    function forward(bytes _evmCallScript) public {
        require(canForward(msg.sender, _evmCallScript), ERROR_CAN_NOT_FORWARD);
        _delayExecution(_evmCallScript);
    }

    function _delayExecution(bytes _evmCallScript) internal returns (uint256) {
        uint256 delayedScriptIndex = delayedScriptsNewIndex;
        delayedScriptsNewIndex++;

        delayedScripts[delayedScriptIndex] = DelayedScript(now.add(executionDelay) , _evmCallScript, 0);

        emit DelayedScriptStored(delayedScriptIndex);

        return delayedScriptIndex;
    }

    /**
    * @notice Pause the script execution with ID `_delayedScriptId`
    * @param _delayedScriptId The ID of the script execution to pause
    */
    function pauseExecution(uint256 _delayedScriptId) external auth(PAUSE_EXECUTION_ROLE) {
        require(canPause(_delayedScriptId), ERROR_CAN_NOT_PAUSE);
        _pauseExecution(_delayedScriptId);
    }

    /**
    * @notice Resume a paused script execution with ID `_delayedScriptId`
    * @param _delayedScriptId The ID of the script execution to resume
    */
    function resumeExecution(uint256 _delayedScriptId) external auth(RESUME_EXECUTION_ROLE) {
        require(canResume(_delayedScriptId), ERROR_CAN_NOT_RESUME);
        _resumeExecution(_delayedScriptId);
    }

    function cancelExecution(uint256 _delayedScriptId) external auth(CANCEL_EXECUTION_ROLE) {
        _cancelExecution(_delayedScriptId);
    }

    /**
    * @notice Execute the script with ID `_delayedScriptId`
    * @param _delayedScriptId The ID of the script to execute
    */
    function execute(uint256 _delayedScriptId) external {
        require(canExecute(_delayedScriptId), ERROR_CAN_NOT_EXECUTE);

        runScript(delayedScripts[_delayedScriptId].evmCallScript, new bytes(0), new address[](0));

        delete delayedScripts[_delayedScriptId];

        emit ExecutedScript(_delayedScriptId);
    }

    function canPause(uint256 _scriptId) public view scriptExists(_scriptId) returns (bool) {
        return !_isExecutionPaused(_scriptId) && now < delayedScripts[_scriptId].executionTime;
    }

    function canResume(uint256 _scriptId) public view scriptExists(_scriptId) returns (bool) {
        return _isExecutionPaused(_scriptId);
    }

    /**
    * @notice Tells whether a script with ID #`_scriptId` can be executed or not
    * @param _scriptId The ID of the script to execute
    */
    function canExecute(uint256 _scriptId) public scriptExists(_scriptId) returns (bool) {

        if (_isExecutionPaused(_scriptId))
            return false;

        bool withinExecutionWindow = now > delayedScripts[_scriptId].executionTime;
        return withinExecutionWindow;
    }

    function _isExecutionPaused(uint256 _scriptId) internal view returns (bool) {
        return delayedScripts[_scriptId].pausedAt != 0;
    }

    function _pauseExecution(uint256 _scriptId) internal {
        delayedScripts[_scriptId].pausedAt = now;
        emit ExecutionPaused(_scriptId);
    }

    function _resumeExecution(uint256 _scriptId) internal {
        DelayedScript storage delayedScript = delayedScripts[_scriptId];

        uint256 timePaused = now.sub(delayedScript.pausedAt);
        delayedScript.executionTime = delayedScript.executionTime.add(timePaused);
        delayedScript.pausedAt = 0;

        emit ExecutionResumed(_scriptId);
    }

    function _cancelExecution(uint256 _scriptId) internal {
        delete delayedScripts[_scriptId];

        emit ExecutionCancelled(_scriptId);
    }

}
