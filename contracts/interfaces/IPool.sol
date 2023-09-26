// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IPoolSafe} from "./IPoolSafe.sol";

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
     * @notice Submits redemption request to the pool
     */
    function submitRedemptionRequest(uint256 amounts) external;

    /**
     * @notice Updates the assets for the two tranches with the specified values.
     * @dev This function should only be called after `refreshPool` is called to bring
     * the assets data up-to-date.
     * @param assets The amount of assets for each tranche to update to.
     */
    function updateTranchesAssets(uint96[2] memory assets) external;

    function isPoolOn() external view returns (bool status);

    function readyForFirstLossCoverWithdrawal() external view returns (bool ready);
}
