// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CreditConfig, ReceivableInfo} from "../CreditStructs.sol";

interface IReceivableCredit {
    function approveReceivable(bytes32 creditHash, uint256 receivableId) external;

    function rejectReceivable(bytes32 creditHash, uint256 receivableId) external;

    function drawdownWithReceivable(
        bytes32 creditHash,
        uint256 receivableId,
        uint256 amount,
        ReceivableInfo memory receivableInfo
    ) external;
}
