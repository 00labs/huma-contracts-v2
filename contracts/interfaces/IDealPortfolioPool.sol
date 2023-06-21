// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

/**
 * @notice IDealPortfolioPool is the core contract to connect senior/junior tranche vaults to multiple loans.
 */

interface IDealPortfolioPool {
    /**
     * @notice Gets senior/junior tranche total assets
     * @param index the index represents senior tranche or junior tranche
     * @return tranche total assets
     */
    function trancheTotalAssets(uint256 index) external view returns (uint256);

    /**
     * @notice Updates the pool data, including all active loans data,
     * all fees comming from profits, senior and junior tranche assets
     */
    function updatePool() external returns (uint96[2] memory);
}
