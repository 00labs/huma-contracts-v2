// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

/**
 * @notice ITranchesPolicy defines the profit sharing policy between different tranches
 */

interface ITranchesPolicy {
    /**
     * @notice View function of distributing loss to tranches
     * @dev Passing asset value for the tranches as a parameter to make the function stateless
     * @param loss the loss amount
     * @param assets assets for each tranche, index 0 for senior, 1 for junior
     * @return updatedAssets updated total assets for each tranche
     * @return losses losses for each tranche
     */
    function distLossToTranches(
        uint256 loss,
        uint96[2] memory assets
    ) external view returns (uint96[2] memory updatedAssets, uint96[2] memory losses);

    /**
     * @notice View function of distributing loss recovery to tranches
     * @dev Passing asset value for the tranches as a parameter to make the function stateless
     * @param lossRecovery the loss recovery amount
     * @param assets assets for each tranche, index 0 for senior, 1 for junior
     * @param losses losses for each tranche, index 0 for senior, 1 for junior
     * @return remainingLossRecovery the remaining loss recovery after distributing among tranches
     * @return newAssets updated total assets for each tranche, index 0 for senior, 1 for junior
     * @return newLosses updated total losses for each tranche, index 0 for senior, 1 for junior
     */
    function distLossRecoveryToTranches(
        uint256 lossRecovery,
        uint96[2] memory assets,
        uint96[2] memory losses
    )
        external
        view
        returns (
            uint256 remainingLossRecovery,
            uint96[2] memory newAssets,
            uint96[2] memory newLosses
        );

    /**
     * @notice View function of distributing profit to tranches
     * @dev Passing asset value for the tranches as a parameter to make the function stateless
     * @param profit the profit amount
     * @param assets assets for each tranche, assets[0] for senior and assets[1] for junior
     * @param lastUpdatedTime the corresponding updated timestamp for @param assets
     * @return newAssets updated total assets for each tranche, index 0 for senior, 1 for junior
     */
    function distProfitToTranches(
        uint256 profit,
        uint96[2] memory assets,
        uint256 lastUpdatedTime
    ) external view returns (uint96[2] memory newAssets);
}
