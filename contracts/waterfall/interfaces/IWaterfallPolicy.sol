// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

/**
 * @notice IWaterfallPolicy defines the profit sharing policy between different tranches
 */

interface IWaterfallPolicy {
    /**
     * @notice Distributes profit among tranches
     * @dev Passing the asset value for each tranche to make this function stateless
     * @param profit the profit amount
     * @param assets total assets for each tranche, assets[0] for senior and assets[1] for junior
     * @param lastUpdatedTime the corresponding updated timestamp for @param assets.
     * @return newAssets updated assets for each tranche, assets[0] for senior and assets[1] for junior
     */
    function distributeProfit(
        uint256 profit,
        uint96[2] memory assets,
        uint256 lastUpdatedTime
    ) external view returns (uint96[2] memory newAssets);

    /**
     * @notice Distributes loss among tranches
     * @dev Passing the asset value for each tranche to make this function stateless
     * @param loss the loss amount
     * @param assets total assets for each tranche, assets[0] for senior and assets[1] for junior
     * @return newAssets updated assets for each tranche, assets[0] for senior and assets[1] for junior
     */
    function distributeLoss(
        uint256 loss,
        uint96[2] memory assets
    ) external view returns (uint96[2] memory newAssets);

    function distributeLossRecovery(
        uint256 lossRecovery,
        uint96[2] memory assets,
        uint96[2] memory losses
    ) external view;

    // todo Need an interface to handle loss recoveries. This can be tricky since we do not seem
    // to have record of distribution of past losses.
}
