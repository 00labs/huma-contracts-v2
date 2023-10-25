// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

/**
 * @notice IPool is a core contract that connects the lender lender side (via tranches)
 * and the borrower side (via Credit).
 */
interface IPool {
    /**
     * @notice Gets senior/junior tranche total assets
     * @param index the index represents senior tranche or junior tranche
     * @return tranche total assets
     */
    function trancheTotalAssets(uint256 index) external view returns (uint256);

    function totalAssets() external view returns (uint256);

    /**
     * @notice Refreshes the pool data, including all active loans data,
     * profit for the pool and the asset value for different tranches.
     * @return assets the updates assets for each tranche.
     */
    function refreshPool() external returns (uint96[2] memory assets);

    /**
     * @notice Updates the assets for the two tranches with the specified values.
     * @dev This function should only be called after `refreshPool` is called to bring
     * the assets data up-to-date.
     * @param assets The amount of assets for each tranche to update to.
     */
    function updateTranchesAssets(uint96[2] memory assets) external;

    function isPoolOn() external view returns (bool status);

    function readyForFirstLossCoverWithdrawal() external view returns (bool ready);

    /**
     * @notice Gets all the reserved assets for first loss covers. PoolSafe uses this function to reserve
     * the balance of first loss covers
     */
    function getReservedAssetsForFirstLossCovers() external view returns (uint256 reservedAssets);

    /**
     * @notice Gets the available cap of specified first loss cover including reserved profit and loss recovery
     * PoolFeeManager uses this function to invest available liquidity of fees in first loss cover
     */
    function getFirstLossCoverAvailableCap(
        address coverAddress,
        uint256 poolAssets
    ) external view returns (uint256 availableCap);
}
