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

    function drawdownWithReceivable(
        address borrower,
        uint256 receivableId,
        uint256 amount
    ) external;

    function makePaymentWithReceivable(
        address borrower,
        uint256 receivableId,
        uint256 amount
    ) external returns (uint256 amountPaid, bool paidoff);

    function getCreditRecord(uint256 receivableId) external view returns (CreditRecord memory);
}
