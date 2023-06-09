// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

/**
 * @notice ITrancheLogic distributes profit or loss betwwen senior tranche and junior tranche
 */

interface ITrancheLogic {
    /**
     * @notice Distributes profit between senior tranche and junior tranche.
     * @param profit the profit amount
     * @param assets the tranches total assets, assets[0] is senior tranche assets, assets[1] is junior tranche assets.
     * @param lastUpdatedTime the corresponding updated timestamp for @param assets.
     * @return newAssets the new tranches total assets after profit distribution, newAssets[0] is senior tranche assets,
     * newAssets[1] is junior tranche assets.
     */
    function distributeProfit(
        uint256 profit,
        uint96[2] memory assets,
        uint256 lastUpdatedTime
    ) external view returns (uint96[2] memory newAssets);

    /**
     * @notice Distributes loss between senior tranche and junior tranche.
     * @param loss the loss amount
     * @param assets the tranches total assets, assets[0] is senior tranche assets, assets[1] is junior tranche assets.
     * @param lastUpdatedTime the corresponding updated timestamp for @param assets.
     * @return newAssets the new tranches total assets after loss distribution, newAssets[0] is senior tranche assets,
     * newAssets[1] is junior tranche assets.
     */
    function distributeLoss(
        uint256 loss,
        uint96[2] memory assets,
        uint256 lastUpdatedTime
    ) external view returns (uint96[2] memory newAssets);
}
