// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

/**
 * @notice IDealManager provides functions about fees.
 */

interface IFeeManager {
    /**
     * @notice Calculates fees
     * @param params a unique hash for the loan, params[0] is profit amount.
     * @return protocolFee the protocol fee
     * @return ownerFee the pool owner fee
     * @return remaining profit remaining after deducting various fees
     */
    function calculateFees(
        uint256[] memory params
    ) external view returns (uint256 protocolFee, uint256 ownerFee, uint256 remaining);
}
