// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

/**
 * @notice RedemptionSummary is a summary of a group of redemption requests. It captures
 * the total number of shares requested, number of shoares actually redeemed and the
 * associated amount.
 */

struct RedemptionSummary {
    uint64 epochId;
    // The total number of shares requested for redemption in this epoch
    uint96 totalSharesRequested;
    // The total number of shares processed for redemption in this epoch
    uint96 totalSharesProcessed;
    // The total amount redeemed in this epoch
    uint96 totalAmountProcessed;
}

interface IRedemptionHandler {
    /**
     * @notice Returns unprocessed epoch info.
     */
    function currentRedemptionSummary() external view returns (RedemptionSummary memory);

    /**
     * @notice Executes the redemption bundle by transferring assets
     * @param processedRedemptionSummary a processed redemption summary with information on how many shares
     * have been approved to redeem
     */
    function executeRedemptionSummary(
        RedemptionSummary memory processedRedemptionSummary
    ) external;
}
