// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {DealConfig} from "../../DealStructs.sol";

struct ReceivableInfo {
    address receivableAsset;
    uint96 receivableAmount;
    uint256 receivableId;
}

interface IReceivableFactoring {
    function approve(
        address borrower,
        uint256 creditLimit,
        DealConfig calldata creditConfig,
        ReceivableInfo memory receivableInfo
    ) external returns (bytes32 hash);

    function drawdown(bytes32 hash, uint256 borrowAmount) external;

    function makePayment(
        bytes32 creditHash,
        uint256 amount
    ) external returns (uint256 amountPaid, bool paidoff);
}
