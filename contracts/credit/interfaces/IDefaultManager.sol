// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;
import {CreditRecord} from "../CreditStructs.sol";

/**
 * @notice IDefaultManager defines default behaviors
 */

interface IDefaultManager {
    function getCreditCurrentValue(CreditRecord memory cr, uint256 defaultTime) external view returns (uint256 creditValue);
}
