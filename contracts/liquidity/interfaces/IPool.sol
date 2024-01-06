// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

/**
 * @notice IPool is a core contract that connects the lender side (via tranches)
 * and the borrower side (via Credit).
 */
interface IPool {
    /**
     * @notice Distributes profit to admins, senior and junior tranches, and first loss covers
     * @param profit the amount of profit to be distributed
     */
    function distributeProfit(uint256 profit) external;

    /**
     * @notice Distributes loss to first loss covers, junior tranche and senior tranche
     * @param loss the amount of loss to be distributed
     */
    function distributeLoss(uint256 loss) external;

    /**
     * @notice Distributes loss recovery to senior tranche, junior tranche and first loss covers
     * @param lossRecovery the amount that was deemed as losses before and has been receovered.
     * This amount shall be distributed to senior tranche, junior tranche, and first loss covers
     * in this sequenence to offset the losses that they have experienced before.
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
     * @notice Gets senior/junior tranche total assets
     * @param index the index represents senior tranche or junior tranche
     * @return tranche total assets
     */
    function trancheTotalAssets(uint256 index) external view returns (uint256);

    function totalAssets() external view returns (uint256);

    function currentTranchesAssets() external view returns (uint96[2] memory assets);

    function isPoolOn() external view returns (bool status);

    function getTrancheAvailableCap(uint256 index) external view returns (uint256 availableCap);

    function readyForFirstLossCoverWithdrawal() external view returns (bool ready);
}
