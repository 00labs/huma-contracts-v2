// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

/**
 * @notice IPool is a core contract that connects the lender side (via tranches)
 * and the borrower side (via Credit).
 */
interface IPool {
    /**
     * @notice Distributes profit to pool admins, senior and junior tranches, and first loss covers.
     * @param profit The amount of profit to distribute.
     */
    function distributeProfit(uint256 profit) external;

    /**
     * @notice Distributes loss to first loss covers, junior tranche and senior tranche.
     * @param loss The amount of loss to distribute.
     */
    function distributeLoss(uint256 loss) external;

    /**
     * @notice Distributes loss recovery to senior tranche, junior tranche and first loss covers.
     * @param lossRecovery The amount that was deemed as losses before and has been recovered.
     * This amount shall be distributed to senior tranche, junior tranche, and first loss covers
     * in this sequence to offset the losses that they have experienced before.
     */
    function distributeLossRecovery(uint256 lossRecovery) external;

    /**
     * @notice Updates the assets for the two tranches with the specified values.
     * @dev This function should only be called after `refreshPool` is called to bring
     * the assets data up-to-date.
     * @param assets The amount of assets for each tranche to update to.
     */
    function updateTranchesAssets(uint96[2] memory assets) external;

    /**
     * @notice Returns the total assets in the tranche specified by the given index.
     * @param index The index representing senior tranche or junior tranche.
     * @return Tranche total assets.
     */
    function trancheTotalAssets(uint256 index) external view returns (uint256);

    /**
     * @notice Returns the combined total asset of the junior and senior tranches.
     * @return The total asset of both junior and senior tranches.
     */
    function totalAssets() external view returns (uint256);

    /**
     * @notice Returns the assets in each tranche.
     * @return assets The assets in each tranche as an array.
     */
    function currentTranchesAssets() external view returns (uint96[2] memory assets);

    /**
     * @notice Returns the on/off status of the pool
     * @return status The on/off status of the pool.
     */
    function isPoolOn() external view returns (bool status);

    /**
     * @notice Returns the available capacity that the tranche has for further deposit.
     * @param index The index representing senior tranche or junior tranche.
     * @return availableCap The available capacity of the given tranche.
     */
    function getTrancheAvailableCap(uint256 index) external view returns (uint256 availableCap);

    /**
     * @notice Returns whether the pool is ready for first loss cover withdrawal
     * If this value is `true`, then first loss cover providers can withdraw all of their assets
     * regardless of the liquidity requirements. Otherwise, the providers can only withdraw the excessive
     * amount over the min liquidity required.
     * @return ready Whether the pool is ready for first loss cover withdrawal.
     */
    function readyForFirstLossCoverWithdrawal() external view returns (bool ready);
}
