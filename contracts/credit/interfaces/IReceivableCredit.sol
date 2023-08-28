// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CreditConfig, ReceivableInfo} from "../CreditStructs.sol";

interface IReceivableCredit {
    function approveReceivable(address borrower, uint256 receivableId) external;

    function rejectReceivable(address borrower, uint256 receivableId) external;

    function drawdownWithReceivable(
        address borrower,
        address receivableAddress,
        uint256 receivableId,
        uint256 amount,
        ReceivableInfo memory receivableInfo
    ) external;
}
