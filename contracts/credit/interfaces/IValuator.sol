// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;
import {CreditRecord} from "../CreditStructs.sol";

/**
 * @notice IValuator defines the present value of a credit record based on the default and discount policy
 */

interface IValuator {
    function getCreditPresentProfit(
        CreditRecord memory cr
    ) external view returns (uint256 creditValue);

    function getCreditPresentLoss(
        CreditRecord memory cr
    ) external view returns (uint256 creditValue);

    function getCreditPresentValue(
        CreditRecord memory cr
    ) external view returns (uint256 creditValue);
}
