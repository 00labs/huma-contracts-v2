// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {ReceivableState} from "../CreditStructs.sol";

interface IReceivableBackedCreditLineManager {
    /**
     * @notice Approves a receivable, adjusts availableCredit by applying the advance ratio
     * @dev Only when the protocol and pool are live.
     * @custom:access Only the EA service account or the Credit contract can call this function
     */
    function approveReceivable(address borrower, uint256 receivableId) external;

    /**
     * @notice Decreases the amount that the borrower can borrow from the credit line due to new drawdown.
     */
    function decreaseCreditLimit(bytes32 creditHash, uint256 amount) external;

    /**
     * @notice Validates the receivable is owned by the borrower.
     */
    function validateReceivableOwnership(address borrower, uint256 receivableId) external view;

    /**
     * @notice Validates the receivable status, including its state and maturity date.
     */
    function validateReceivableStatus(uint256 maturityDate, ReceivableState state) external view;
}
