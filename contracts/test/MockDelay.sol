pragma solidity ^0.4.24;

import "../Delay.sol";
import "@aragon/contract-test-helpers/contracts/TimeHelpersMock.sol";

contract MockDelay is Delay, TimeHelpersMock {}
