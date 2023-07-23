// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CreditConfig, ReceivableInfo} from "../CreditStructs.sol";

interface ICreditFacility {
    function addReceivable(bytes32 creditHash, ReceivableInfo memory receivableInfo) external;

    function approveReceivable(bytes32 creditHash, ReceivableInfo memory receivableInfo) external;

    function bookReceivablePayment(ReceivableInfo memory receivableInfo) external;

    function closeReceivable(ReceivableInfo memory receivableInfo) external;

    function drawdownWithReceivable(
        bytes32 creditHash,
        uint256 amount,
        ReceivableInfo memory receivableInfo
    ) external;
}
