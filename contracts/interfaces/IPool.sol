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

    /**
     * @notice Refreshes the pool data, including all active loans data,
     * profit for the pool and the asset value for different tranches.
     */
    function refreshPool() external returns (uint96[2] memory);
}
