// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CreditRecord, DueDetail} from "../CreditStructs.sol";

interface IReceivableFactoringCredit {
    /**
     * @notice Allows the borrower to drawdown using a receivable.
     * @param borrower The address of the borrower.
     * @param receivableId The ID of the receivable.
     * @param amount The amount to borrow.
     * @return netAmountToBorrower The net amount disbursed to the borrower.
     * @custom:access Only the owner of the credit line can drawdown.
     */
    function drawdownWithReceivable(
        address borrower,
        uint256 receivableId,
        uint256 amount
    ) external returns (uint256 netAmountToBorrower);

    /**
     * @notice Makes one payment for the credit previously drawndown with the given receivable.
     * If this is the final payment, it automatically triggers the payoff process.
     * @notice Warning: payments should be made by calling this function. No token should be transferred directly
     * to the contract.
     * @param borrower The address of the borrower.
     * @param receivableId The ID of the receivable.
     * @param amount The payment amount.
     * @return amountPaid The actual amount paid to the contract. When the tendered
     * amount is larger than the payoff amount, the contract only accepts the payoff amount.
     * @return paidoff A flag indicating whether the account has been paid off.
     * @custom:access Only the borrower can call this function.
     */
    function makePaymentWithReceivable(
        address borrower,
        uint256 receivableId,
        uint256 amount
    ) external returns (uint256 amountPaid, bool paidoff);

    /**
     * @notice Returns the date that the bill should be refreshed.
     * @param receivableId The ID of the receivable.
     * @return refreshDate The date that the bill should be refreshed.
     */
    function getNextBillRefreshDate(
        uint256 receivableId
    ) external view returns (uint256 refreshDate);

    /**
     * @notice Returns the bill with up-to-date due info.
     * @param receivableId The ID of the receivable.
     * @return cr The new `CreditRecord` with updated due information.
     * @return dd The dew `DueDetail` with updated due information.
     */
    function getDueInfo(
        uint256 receivableId
    ) external view returns (CreditRecord memory cr, DueDetail memory dd);

    /**
     * @notice Returns the credit record associated with the given receivable.
     * @param receivableId The ID of the receivable.
     * @return The CreditRecord if the credit associated with the receivable.
     */
    function getCreditRecord(uint256 receivableId) external view returns (CreditRecord memory);
}
