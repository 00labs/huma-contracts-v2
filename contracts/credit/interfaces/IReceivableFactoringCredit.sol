// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CreditRecord, DueDetail} from "../CreditStructs.sol";

interface IReceivableFactoringCredit {
    /**
     * @notice Returns the date that the bill should be refreshed.
     * @param receivableId The ID of the receivable
     */
    function getNextBillRefreshDate(
        uint256 receivableId
    ) external view returns (uint256 refreshDate);

    /**
     * @notice Returns the bill with up-to-date due info.
     * @param receivableId The ID of the receivable
     */
    function getDueInfo(
        uint256 receivableId
    ) external view returns (CreditRecord memory cr, DueDetail memory dd);

    /**
     * @notice Allows the borrower to drawdown using a receivable.
     */
    function drawdownWithReceivable(
        address borrower,
        uint256 receivableId,
        uint256 amount
    ) external;

    /**
     * @notice Makes one payment for the credit previously drawndown with the given receivable.
     * This can be only be initiated by the borrower.
     * If this is the final payment, it automatically triggers the payoff process.
     * @return amountPaid the actual amount paid to the contract. When the tendered
     * amount is larger than the payoff amount, the contract only accepts the payoff amount.
     * @return paidoff a flag indicating whether the account has been paid off.
     */
    function makePaymentWithReceivable(
        address borrower,
        uint256 receivableId,
        uint256 amount
    ) external returns (uint256 amountPaid, bool paidoff);

    /**
     * @notice Returns the credit record associated with the given receivable.
     */
    function getCreditRecord(uint256 receivableId) external view returns (CreditRecord memory);
}
