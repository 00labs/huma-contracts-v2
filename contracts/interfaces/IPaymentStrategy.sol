// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

/**
 * @notice IPaymentStrategy calculates interest and principal.
 */

interface IPaymentStrategy {
    /**
     * @notice Calculates accrued interest and accrued principal from last updated timestamp to current timestamp.
     * @param params params
     * params[0] - the principal amount
     * params[1] - the duration
     * params[2] - the apr in bps
     * @return interest the interest of the duration based on the apr
     * @return principal the principal of the duration
     */
    function calculateInterestAndPrincipal(
        uint256[] memory params
    ) external view returns (uint256 interest, uint256 principal);
}
