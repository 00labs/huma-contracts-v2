// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CreditConfig} from "../../CreditStructs.sol";

/**
 * @notice ICreditFeeManager defines functions to compute credit-related fees
 */

interface ICreditFeeManager {
    /**
     * @notice Calculates accrued interest and accrued principal from last updated timestamp to current timestamp.
     * @param principal the principal amount
     * @param startTime the loan start timestamp
     * @param lastUpdatedTime the last updated timestamp
     * @param dealConfig the schedule and payment parameters for this loan
     * @return accruedInterest the accrued interest from last updated timestamp to current timestamp,
     * the accrued principal from last updated timestamp to current timestamp,
     */
    function getDueInfo(
        uint256 principal,
        uint256 startTime,
        uint256 lastUpdatedTime,
        CreditConfig memory dealConfig
    ) external view returns (uint256 accruedInterest, uint256 accruedPrincipal);
}
