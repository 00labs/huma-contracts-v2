// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {DealConfig} from "../DealStructs.sol";

interface IDealManager {
    function approveDeal(
        bytes32 dealHash,
        address borrower,
        uint256 dealPrincipal,
        DealConfig calldata scheduleOption
    ) external;

    function drawdown(bytes32 dealHash, uint256 borrowAmount) external;

    function makePayment(bytes32 dealHash, uint256 amount) external;
}
