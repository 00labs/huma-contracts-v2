// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

/**
 * @notice ITranchesPolicy defines the profit sharing policy between different tranches
 */

interface ITranchesPolicy {
    /**
     * @notice Calculates profit distributions among tranches
     * @dev Passing the asset value for each tranche to make this function stateless
     * @param profit the profit amount
     * @param assets total assets for each tranche, assets[0] for senior and assets[1] for junior
     * @param lastUpdatedTime the corresponding updated timestamp for @param assets
     * @return newAssets the new total assets for each tranche, newAssets[0] for senior and newAssets[1] for junior
     */
    function calcTranchesAssetsForProfit(
        uint256 profit,
        uint96[2] memory assets,
        uint256 lastUpdatedTime
    ) external view returns (uint96[2] memory newAssets);

    /**
     * @notice Calculates loss distributions among tranches
     * @dev Passing the asset value for each tranche to make this function stateless
     * @param loss the loss amount
     * @param assets total assets for each tranche, assets[0] for senior and assets[1] for junior
     * @return newAssets the new total assets for each tranche, newAssets[0] for senior and newAssets[1] for junior
     */
    function calcTranchesAssetsForLoss(
        uint256 loss,
        uint96[2] memory assets
    ) external view returns (uint96[2] memory newAssets);

    /**
     * @notice Calculates loss recovery distributions among tranches
     * @dev Passing the asset value for each tranche to make this function stateless
     * @param lossRecovery the loss recovery amount
     * @param assets total assets for each tranche, assets[0] for senior and assets[1] for junior
     * @param losses the loss for each tranche, losses[0] for senior and losses[1] for junior
     * @return remainingLossRecovery the remaining loss recovery after distributing among tranches
     * @return newAssets the new total assets for each tranche, newAssets[0] for senior and newAssets[1] for junior
     * @return newLosses the new losses for each tranche, newLosses[0] for senior and newLosses[1] for junior
     */
    function calcTranchesAssetsForLossRecovery(
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
}
