// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

/**
 * @notice ITranchesPolicy defines the profit sharing policy between different tranches
 */

interface ITranchesPolicy {
    /**
     * @notice Distributes profit among tranches
     * @dev Passing the asset value for each tranche to make this function stateless
     * @param profit the profit amount
     * @param assets total assets for each tranche, assets[0] for senior and assets[1] for junior,
     * the updated traches assets are assigned to this parameter
     * @param lastUpdatedTime the corresponding updated timestamp for @param assets
     */
    function distributeProfit(
        uint256 profit,
        uint96[2] memory assets,
        uint256 lastUpdatedTime
    ) external view;

    /**
     * @notice Distributes loss among tranches
     * @dev Passing the asset value for each tranche to make this function stateless
     * @param loss the loss amount
     * @param assets total assets for each tranche, assets[0] for senior and assets[1] for junior,
     * the updated traches assets are assigned to this parameter
     */
    function distributeLoss(uint256 loss, uint96[2] memory assets) external view;

    function distributeLossRecovery(
        uint256 lossRecovery,
        uint96[2] memory assets,
        uint96[2] memory losses
    ) external view;
}
