// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CreditRecord} from "../CreditStructs.sol";

interface IReceivableBackedCreditLineManager {
    /**
     * @notice Approves a receivable, adjusts availableCredit by applying the advance ratio
     * @dev Only when the protocol and pool are live.
     * @custom:access Only the EA service account or the Credit contract can call this function
     */
    function approveReceivable(address borrower, uint256 receivableId) external;

    /**
     * @notice Validates the receivable, e.g. checking if the receivable is owned by the borrower.
     */
    function validateReceivable(address borrower, uint256 receivableId) external;

    /**
     * @notice Decreases the amount that the borrower can borrow from the credit line due to new drawdown.
     */
    function decreaseCreditLimit(bytes32 creditHash, uint256 amount) external;
}
