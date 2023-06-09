// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {DealConfig} from "../DealStructs.sol";

/**
 * @notice IDealManager provides loan functions
 */

interface IDealManager {
    /**
     * @notice EA calls this function to approve a loan.
     * @param dealHash a unique hash for the loan
     * @param borrower loan borrower address
     * @param dealPrincipal approved loan principal
     * @param dealConfig the schedule and payment parameters for this loan
     */
    function approveDeal(
        bytes32 dealHash,
        address borrower,
        uint256 dealPrincipal,
        DealConfig calldata dealConfig
    ) external;

    /**
     * @notice Borrows principal from a loan.
     * @param dealHash a unique hash for the loan
     * @param borrowAmount the borrow amount
     */
    function drawdown(bytes32 dealHash, uint256 borrowAmount) external;

    function makePayment(bytes32 dealHash, uint256 amount) external;
}
