// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {DealConfig} from "../DealStructs.sol";

/**
 * @notice IDealPortfolioPool is the core contract to connect senior/junior tranche vaults to multiple loans.
 */

interface IDealPortfolioPool {
    /**
     * @notice Creates loan config data
     * @param dealHash a unique hash for the loan
     * @param dealConfig the schedule and payment parameters for this loan
     */
    function createDealConfig(bytes32 dealHash, DealConfig memory dealConfig) external;

    /**
     * @notice Updates loan data when borrowers borrow
     * @param dealHash a unique hash for the loan
     * @param amount borrowed amount
     */
    function borrowFromDeal(bytes32 dealHash, uint256 amount) external;

    /**
     * @notice Updates loan data when borrowers pay
     * @param dealHash a unique hash for the loan
     * @param amount paid amount
     */
    function payToDeal(bytes32 dealHash, uint256 amount) external;

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
