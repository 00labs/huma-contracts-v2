// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {MockToken} from "contracts/common/mock/MockToken.sol";
import {HumaConfig} from "contracts/common/HumaConfig.sol";
import {EvaluationAgentNFT} from "contracts/common/EvaluationAgentNFT.sol";

import {Test} from "forge-std/Test.sol";

contract BaseTest is Test {
    address public treasury;

    MockToken public mockToken;
    HumaConfig public humaConfig;
    EvaluationAgentNFT public evaluationAgentNFT;

    function setUp() public virtual {}

    function _createProtocolContracts() internal {
        treasury = makeAddr("treasury");

        mockToken = new MockToken();
        humaConfig = new HumaConfig();
        evaluationAgentNFT = new EvaluationAgentNFT();
    }
}
