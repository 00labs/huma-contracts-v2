// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

/**
 * @notice EpochRedemptionSummary is a summary of a group of redemption requests. It captures
 * the total number of shares requested, number of shares actually redeemed and the
 * associated amount.
 */
struct EpochRedemptionSummary {
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
     * @notice Executes the redemption requests in contained in the redemption summary by transferring assets.
     * @param processedRedemptionSummary A processed redemption summary with information on how many shares
     * have been approved to redeem.
     */
    function executeRedemptionSummary(
        EpochRedemptionSummary memory processedRedemptionSummary
    ) external;

    /**
     * @notice Returns the redemption summary for the epoch with the given epoch ID.
     * @param epochId The ID of the epoch for which to get the redemption summary.
     * @return redemptionSummary The EpochRedemptionSummary for the epoch with the given epoch ID.
     */
    function epochRedemptionSummary(
        uint256 epochId
    ) external view returns (EpochRedemptionSummary memory redemptionSummary);
}
