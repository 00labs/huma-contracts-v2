// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {ReceivableState} from "../CreditStructs.sol";

interface IReceivableBackedCreditLineManager {
    /**
     * @notice Approves a receivable, adjusts available credit by applying the advance ratio.
     * @param borrower The address of the borrower.
     * @param receivableId The ID of the receivable.
     * @custom:access Only the EA or the Credit contract can call this function.
     */
    function approveReceivable(address borrower, uint256 receivableId) external;

    /**
     * @notice Decreases the amount that the borrower can borrow from the credit line due to new drawdown.
     * @param creditHash The hash of the credit.
     * @param amount The amount to decrease the avaible credit by.
     * @custom:access Only the Credit contract can call this function.
     */
    function decreaseCreditLimit(bytes32 creditHash, uint256 amount) external;

    /**
     * @notice Validates the receivable is owned by the borrower.
     * @param borrower The address of the borrower.
     * @param receivableId The ID of the receivable.
     */
    function validateReceivableOwnership(address borrower, uint256 receivableId) external view;

    /**
     * @notice Returns the amount of available credits approved for the borrower.
     * @param borrower The address of the borrower.
     * @return availableCredit The amount of available credits approved for the borrower.
     */
    function getAvailableCredit(address borrower) external view returns (uint256 availableCredit);

    /**
     * @notice Validates the receivable status, including its state and maturity date.
     * @param maturityDate The date on which the receivable becomes due.
     * @param state The state of the receivable.
     */
    function validateReceivableStatus(uint256 maturityDate, ReceivableState state) external view;
}
